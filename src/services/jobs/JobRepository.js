'use strict';

const admin = require('firebase-admin');
const alertStorageService = require('../storage/AlertStorageService');
const { firestoreWriteMetricsService } = require('../storage/FirestoreWriteMetricsService');

const WRITE_METRICS_DOMAIN_JOBS = 'jobs';

const COLLECTION_NAME = 'tradingviewJobs';
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const TERMINAL_STATUSES = TERMINAL_JOB_STATUSES;
const memoryJobs = new Map();
const saveVersions = new Map();
const pendingSaves = new Map();
const DEFAULT_CLAIM_LEASE_MS = 60000;
const DEFAULT_CALLBACK_CLAIM_LEASE_MS = 60000;
const TERMINAL_JOB_RETENTION_MS = 3600000;

function createAbortError(signal) {
	return signal?.reason || Object.assign(new Error('Job repository read aborted.'), { name: 'AbortError' });
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw createAbortError(signal);
}

function awaitWithAbort(promise, signal) {
	throwIfAborted(signal);
	if (!signal) return promise;
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(createAbortError(signal));
		signal.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
	});
}

function cloneJob(job) {
	if (!job) return null;
	return JSON.parse(JSON.stringify(job));
}

function mergeCallbackStatus(currentStatus, incomingStatus) {
	if (!currentStatus) return incomingStatus;
	if (!incomingStatus) return currentStatus;

	return {
		...incomingStatus,
		...currentStatus,
		events: {
			...(incomingStatus.events || {}),
			...(currentStatus.events || {}),
		},
	};
}

function isFirestoreEnabled() {
	return process.env.ENABLE_FIRESTORE_JOB_STORAGE === 'true'
		|| process.env.ENABLE_FIRESTORE_ALERT_STORAGE === 'true';
}

// Whether a durable execution record counts as queued backlog depth: never started,
// or a claim whose lease has already expired and can therefore never complete.
// A row can become queued on its own as time passes, which is why a rotation cycle
// spanning several probes is not a consistent view of the collection.
function isQueuedExecution(execution, now = Date.now()) {
	if (execution.status === 'queued') return true;
	if (!['claimed', 'running'].includes(execution.status)) return false;
	const leaseUntilMs = Date.parse(execution.leaseUntil || '');
	return Number.isFinite(leaseUntilMs) && leaseUntilMs <= now;
}

function sanitizeJob(job) {
	const copy = cloneJob(job);
	if (!copy) return null;
	delete copy.payload;
	delete copy.bot;
	delete copy.botOrGetter;
	delete copy.signal;
	delete copy._workerId;
	return copy;
}

function addTerminalExpiry(job) {
	if (!TERMINAL_JOB_STATUSES.has(job.status)) {
		return job;
	}

	const createdAtMs = new Date(job.createdAt).getTime();
	if (!Number.isFinite(createdAtMs)) {
		return job;
	}

	return {
		...job,
		expiresAt: admin.firestore.Timestamp.fromDate(new Date(createdAtMs + TERMINAL_JOB_RETENTION_MS)),
	};
}

function getLocalTerminalJob(jobId) {
	const localJob = saveVersions.get(jobId)?.job || memoryJobs.get(jobId);
	if (!localJob || !TERMINAL_JOB_STATUSES.has(localJob.status)) {
		return null;
	}

	return cloneJob(localJob);
}

function getClaimLeaseMs() {
	const configured = Number(process.env.JOB_QUEUE_CLAIM_LEASE_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CLAIM_LEASE_MS;
}

function createCallbackClaimUnavailableError(cause) {
	const error = new Error('Durable callback claim storage is unavailable.');
	error.code = 'JOB_CALLBACK_CLAIM_UNAVAILABLE';
	error.cause = cause;
	return error;
}

function createCallbackStatusUnavailableError(cause) {
	const error = new Error('Durable callback status storage is unavailable.');
	error.code = 'JOB_CALLBACK_STATUS_UNAVAILABLE';
	error.cause = cause;
	return error;
}

class JobRepository {
	// Rotation cursor for the bounded durable backlog scan. Held on the instance
	// so a sweep that hit its page cap resumes where the previous one stopped,
	// instead of re-reading the same prefix and never reaching a backlog that
	// sorts after it. Cleared when a sweep reaches the end of the collection.
	constructor() {
		this._backlogScanCursor = null;
		this._backlogScanCursorId = null;
		// Bumped whenever the caller accepts a result. A scan captures the current
		// value and only advances the cursor if it is unchanged when the scan
		// finishes, so a request that was abandoned at the caller's probe deadline
		// (and whose result was discarded) cannot move the shared cursor. That would
		// silently skip a window the caller never saw, letting the next sweep close a
		// rotation cycle on evidence with a hole in it.
		this._backlogScanEpoch = 0;
		// Called by the consumer to mark the previous result as accepted.
		this.commitBacklogScan = () => {
			this._backlogScanEpoch += 1;
		};
	}

	async save(job, { required = false } = {}) {
		const sanitized = sanitizeJob(job);
		if (!sanitized || !sanitized.jobId) {
			return null;
		}

		const current = memoryJobs.get(sanitized.jobId);
		const latestJob = saveVersions.get(sanitized.jobId)?.job;
		const terminalJob = [latestJob, current].find((candidate) => (
			candidate && TERMINAL_JOB_STATUSES.has(candidate.status)
		));
		if (terminalJob && terminalJob.status !== sanitized.status) {
			return false;
		}

		const firestore = this._getFirestore();
		if (!firestore) {
			if (isFirestoreEnabled()) {
				firestoreWriteMetricsService.recordWriteFailure(WRITE_METRICS_DOMAIN_JOBS);
			}
			memoryJobs.set(sanitized.jobId, cloneJob(sanitized));
			return sanitized.jobId;
		}

		const version = (saveVersions.get(sanitized.jobId)?.version || 0) + 1;
		saveVersions.set(sanitized.jobId, { version, job: cloneJob(sanitized) });

		let persistedJob = sanitized;
		const durableJob = addTerminalExpiry(sanitized);
		const persistencePromise = (async () => {
			try {
				if (typeof firestore.runTransaction === 'function') {
					const docRef = firestore.collection(COLLECTION_NAME).doc(sanitized.jobId);
					const saved = await firestore.runTransaction(async (transaction) => {
						const snapshot = await transaction.get(docRef);
						const incomingWorkerId = sanitized.execution && sanitized.execution.workerId;
						let currentDoc = null;
						if (snapshot && snapshot.exists) {
							currentDoc = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || sanitized.jobId });
							const currentExecution = currentDoc && currentDoc.execution ? currentDoc.execution : {};
							const currentClaimIsActive = currentExecution.workerId
								&& ['claimed', 'running'].includes(currentExecution.status);
							if (currentClaimIsActive && !incomingWorkerId && !TERMINAL_STATUSES.has(sanitized.status)) {
								return false;
							}
							if (incomingWorkerId && (!currentDoc || (currentDoc.execution || {}).workerId !== incomingWorkerId)) {
								return false;
							}
							if (
								incomingWorkerId
								&& currentExecution.workerId === incomingWorkerId
								&& currentExecution.attempt !== undefined
								&& Number(currentExecution.attempt) !== Number(sanitized.execution.attempt)
							) {
								return false;
							}
							if (currentDoc && TERMINAL_STATUSES.has(currentDoc.status) && currentDoc.status !== sanitized.status) {
								return false;
							}
						}

						persistedJob = incomingWorkerId && currentDoc
							? {
								...durableJob,
								callbackStatus: mergeCallbackStatus(currentDoc.callbackStatus, sanitized.callbackStatus),
							}
							: durableJob;
						transaction.set(docRef, persistedJob);
						return true;
					});
					if (saved === false) {
						return false;
					}
				} else {
					await firestore.collection(COLLECTION_NAME).doc(sanitized.jobId).set(durableJob);
				}
				firestoreWriteMetricsService.recordWriteSuccess(WRITE_METRICS_DOMAIN_JOBS);
			} catch (error) {
				console.warn('[JobRepository] Failed to persist job:', error.message);
				firestoreWriteMetricsService.recordWriteFailure(WRITE_METRICS_DOMAIN_JOBS);
				if (required) {
					memoryJobs.delete(sanitized.jobId);
					const storageError = new Error('Durable job storage is unavailable.');
					storageError.code = 'JOB_STORAGE_UNAVAILABLE';
					throw storageError;
				}
			}
		})();

		const pending = pendingSaves.get(sanitized.jobId) || new Set();
		pending.add(persistencePromise);
		pendingSaves.set(sanitized.jobId, pending);

		try {
			const res = await persistencePromise;
			if (res === false) return null;
		} finally {
			pending.delete(persistencePromise);
			if (!pending.size) {
				pendingSaves.delete(sanitized.jobId);
			}
		}

		memoryJobs.set(sanitized.jobId, cloneJob(persistedJob));
		return sanitized.jobId;
	}

	async updateCallbackStatus(jobId, event, callbackUpdate = {}) {
		if (!jobId || !event) {
			return false;
		}

		const merge = (job) => {
			const existingStatus = job.callbackStatus || {};
			const existingEvent = existingStatus.events && existingStatus.events[event];
			if (
				callbackUpdate.deliveryId
				&& existingEvent
				&& existingEvent.deliveryId
				&& existingEvent.deliveryId !== callbackUpdate.deliveryId
			) {
				return null;
			}
			const attempts = Array.isArray(callbackUpdate.attempts) ? callbackUpdate.attempts : [];
			return {
				...job,
				callbackStatus: {
					status: callbackUpdate.status,
					attempts: [
						...(Array.isArray(existingStatus.attempts) ? existingStatus.attempts : []),
						...attempts,
					],
					events: {
						...(existingStatus.events || {}),
						[event]: {
							...(existingEvent || {}),
							status: callbackUpdate.status,
							attempts,
							...(callbackUpdate.deliveryId ? { deliveryId: callbackUpdate.deliveryId } : {}),
						},
					},
				},
				updatedAt: new Date().toISOString(),
			};
		};

		const firestore = this._getFirestore();
		if (firestore) {
			if (typeof firestore.runTransaction !== 'function') {
				throw createCallbackStatusUnavailableError();
			}

			const docRef = firestore.collection(COLLECTION_NAME).doc(jobId);
			try {
				return await firestore.runTransaction(async (transaction) => {
					const snapshot = await transaction.get(docRef);
					if (!snapshot || !snapshot.exists) {
						return false;
					}

					const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || jobId });
					const nextJob = merge(current);
					if (!nextJob) {
						return false;
					}
					const persistedJob = addTerminalExpiry(nextJob);
					transaction.set(docRef, persistedJob);
					memoryJobs.set(jobId, cloneJob(persistedJob));
					return true;
				});
			} catch (error) {
				console.warn('[JobRepository] Failed to persist callback status:', error.message);
				throw createCallbackStatusUnavailableError(error);
			}
		}

		const current = await this.get(jobId);
		if (!current) {
			return false;
		}

		const nextJob = merge(current);
		if (!nextJob) {
			return false;
		}
		const saved = await this.save(nextJob);
		return saved !== null;
	}

	async claimCallbackDelivery(jobId, event, deliveryId, leaseMs = DEFAULT_CALLBACK_CLAIM_LEASE_MS) {
		if (!jobId || !event || !deliveryId) {
			return false;
		}

		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			throw createCallbackClaimUnavailableError();
		}

		const effectiveLeaseMs = Number.isInteger(leaseMs) && leaseMs > 0
			? leaseMs
			: DEFAULT_CALLBACK_CLAIM_LEASE_MS;
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const docRef = firestore.collection(COLLECTION_NAME).doc(jobId);

		try {
			return await firestore.runTransaction(async (transaction) => {
				const snapshot = await transaction.get(docRef);
				if (!snapshot || !snapshot.exists) {
					return false;
				}

				const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || jobId });
				if (event === 'processing' && current.status !== 'processing') {
					return false;
				}
				const callbackStatus = current.callbackStatus || {};
				const existingEvent = callbackStatus.events && callbackStatus.events[event];
				if (existingEvent && existingEvent.status === 'success') {
					return false;
				}
				if (existingEvent && existingEvent.status === 'in_flight') {
					const startedAtMs = Date.parse(existingEvent.startedAt || '');
					if (Number.isFinite(startedAtMs) && startedAtMs + effectiveLeaseMs > nowMs) {
						const error = new Error('Callback delivery is already in flight.');
						error.code = 'JOB_CALLBACK_DELIVERY_IN_FLIGHT';
						throw error;
					}
				}

				const nextJob = {
					...current,
					callbackStatus: {
						...callbackStatus,
						status: 'in_flight',
						events: {
							...(callbackStatus.events || {}),
							[event]: {
								...(existingEvent || {}),
								status: 'in_flight',
								deliveryId,
								startedAt: now,
							},
						},
					},
					updatedAt: now,
				};
				const persistedJob = addTerminalExpiry(nextJob);
				transaction.set(docRef, persistedJob);
				memoryJobs.set(jobId, cloneJob(persistedJob));
				return true;
			});
		} catch (error) {
			console.warn('[JobRepository] Failed to claim callback delivery:', error.message);
			if (error && error.code === 'JOB_CALLBACK_DELIVERY_IN_FLIGHT') {
				throw error;
			}
			throw createCallbackClaimUnavailableError(error);
		}
	}

	isDurable() {
		return Boolean(this._getFirestore());
	}

	async claim(jobId, workerId) {
		if (!jobId || !workerId) {
			return { claimed: false, reason: 'invalid' };
		}

		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return { claimed: false, reason: 'unavailable' };
		}

		const docRef = firestore.collection(COLLECTION_NAME).doc(jobId);
		const nowMs = Date.now();
		const leaseMs = getClaimLeaseMs();

		try {
			return await firestore.runTransaction(async (transaction) => {
				const snapshot = await transaction.get(docRef);
				if (!snapshot || !snapshot.exists) {
					return { claimed: false, reason: 'missing' };
				}

				const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || jobId });
				if (!current || TERMINAL_STATUSES.has(current.status)) {
					return { claimed: false, reason: 'terminal' };
				}

				const execution = current.execution || {};
				const claimedAtMs = Date.parse(execution.claimedAt || '');
				const leaseUntilMs = Number.isFinite(Date.parse(execution.leaseUntil || ''))
					? Date.parse(execution.leaseUntil)
					: claimedAtMs + leaseMs;
				if (['claimed', 'running'].includes(execution.status) && Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) {
					return { claimed: false, reason: 'active' };
				}

				const nextJob = {
					...current,
					execution: {
						...execution,
						mode: execution.mode || 'render-worker',
						status: 'claimed',
						workerId,
						attempt: Number(execution.attempt || 0) + 1,
						claimedAt: new Date(nowMs).toISOString(),
						leaseUntil: new Date(nowMs + leaseMs).toISOString(),
					},
					updatedAt: new Date(nowMs).toISOString(),
				};

				transaction.set(docRef, nextJob);
				memoryJobs.set(jobId, cloneJob(nextJob));
				return { claimed: true, job: cloneJob(nextJob) };
			});
		} catch (error) {
			console.warn('[JobRepository] Failed to claim job:', error.message);
			return { claimed: false, reason: 'unavailable' };
		}
	}

	async renewClaim(jobId, workerId, attempt = null) {
		if (!jobId || !workerId) {
			return false;
		}

		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			const error = new Error('Durable job claim storage is unavailable.');
			error.code = 'JOB_CLAIM_RENEWAL_UNAVAILABLE';
			throw error;
		}

		const docRef = firestore.collection(COLLECTION_NAME).doc(jobId);
		const nowMs = Date.now();
		const leaseMs = getClaimLeaseMs();

		try {
			return await firestore.runTransaction(async (transaction) => {
				const snapshot = await transaction.get(docRef);
				if (!snapshot || !snapshot.exists) {
					return false;
				}

				const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || jobId });
				const execution = current && current.execution ? current.execution : {};
				if (
					!current
					|| execution.workerId !== workerId
					|| (attempt !== null && attempt !== undefined && Number(execution.attempt) !== Number(attempt))
				) {
					return false;
				}
				if (TERMINAL_STATUSES.has(current.status)) {
					return true;
				}
				if (!['claimed', 'running'].includes(execution.status)) {
					return false;
				}

				const nextJob = {
					...current,
					execution: {
						...execution,
						leaseUntil: new Date(nowMs + leaseMs).toISOString(),
					},
					updatedAt: new Date(nowMs).toISOString(),
				};
				transaction.set(docRef, nextJob);
				memoryJobs.set(jobId, cloneJob(nextJob));
				return true;
			});
		} catch (error) {
			console.warn('[JobRepository] Failed to renew job claim:', error.message);
			error.code = error.code || 'JOB_CLAIM_RENEWAL_UNAVAILABLE';
			throw error;
		}
	}

	async _updateClaim(jobId, workerId, update, attempt = null) {
		if (!jobId || !workerId) {
			return false;
		}
		const hasAttempt = attempt !== null && attempt !== undefined;

		const firestore = this._getFirestore();
		if (firestore) {
			if (typeof firestore.runTransaction !== 'function') {
				return false;
			}

			const docRef = firestore.collection(COLLECTION_NAME).doc(jobId);
			return firestore.runTransaction(async (transaction) => {
				const snapshot = await transaction.get(docRef);
				if (!snapshot || !snapshot.exists) {
					return false;
				}

				const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || jobId });
				const execution = current && current.execution ? current.execution : {};
				if (
					!current
					|| TERMINAL_STATUSES.has(current.status)
					|| execution.workerId !== workerId
					|| (hasAttempt && Number(execution.attempt) !== Number(attempt))
				) {
					return false;
				}

				const nextJob = update(current);
				if (!nextJob) {
					return false;
				}
				const persistedJob = addTerminalExpiry(nextJob);
				transaction.set(docRef, persistedJob);
				memoryJobs.set(jobId, cloneJob(persistedJob));
				return true;
			});
		}

		const job = await this.get(jobId);
		if (
			!job
			|| TERMINAL_STATUSES.has(job.status)
			|| (job.execution || {}).workerId !== workerId
			|| (hasAttempt && Number((job.execution || {}).attempt) !== Number(attempt))
		) {
			return false;
		}

		const nextJob = update(job);
		if (!nextJob) {
			return false;
		}
		await this.save(nextJob, { required: true });
		return true;
	}

	async releaseClaim(jobId, workerId, error, attempt = null) {
		return this._updateClaim(jobId, workerId, (job) => {
			const execution = job.execution || {};
			job.execution = {
				...execution,
				status: 'queued',
				workerId: null,
				claimedAt: null,
				leaseUntil: null,
				lastErrorCode: error && error.code ? error.code : 'JOB_WORKER_FAILED',
			};
			job.updatedAt = new Date().toISOString();
			return job;
		}, attempt);
	}

	async failClaim(jobId, workerId, error, attempt = null) {
		return this._updateClaim(jobId, workerId, (job) => {
			const execution = job.execution || {};
			job.status = 'failed';
			job.error = error && error.message ? error.message : 'Queue worker failed.';
			job.code = error && error.code ? error.code : 'JOB_WORKER_FAILED';
			job.execution = {
				...execution,
				status: 'failed',
				workerId: null,
				claimedAt: null,
				leaseUntil: null,
				completedAt: new Date().toISOString(),
				lastErrorCode: job.code,
			};
			job.updatedAt = new Date().toISOString();
			return job;
		}, attempt);
	}

	async get(jobId, { signal } = {}) {
		if (!jobId) {
			return null;
		}
		throwIfAborted(signal);

		const localJob = saveVersions.get(jobId)?.job || memoryJobs.get(jobId);
		if (localJob && TERMINAL_JOB_STATUSES.has(localJob.status) && pendingSaves.has(jobId)) {
			await getLocalTerminalJob(jobId);
		}

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await awaitWithAbort(
					firestore.collection(COLLECTION_NAME).doc(jobId).get(),
					signal,
				);
				if (snapshot && snapshot.exists) {
					const data = snapshot.data() || {};
					const job = { ...data, jobId: data.jobId || snapshot.id };
					const latestLocalTerminalJob = await getLocalTerminalJob(jobId);
					if (latestLocalTerminalJob) {
						return latestLocalTerminalJob;
					}
					memoryJobs.set(job.jobId, cloneJob(job));
					return cloneJob(job);
				}
			} catch (error) {
				if (error.name === 'AbortError') throw error;
				console.warn('[JobRepository] Failed to read job from Firestore:', error.message);
			}
		}

		return cloneJob(memoryJobs.get(jobId));
	}

	async waitForPendingSaves(jobId) {
		while (true) {
			const pendingSets = jobId ? [pendingSaves.get(jobId)] : [...pendingSaves.values()];
			const pending = [];
			for (const saves of pendingSets) {
				if (saves) pending.push(...saves);
			}

			if (!pending.length) return;
			await Promise.allSettled(pending);
		}
	}

	async list({ status, type, telegramChatId, signal, limit = 50 } = {}) {
		throwIfAborted(signal);
		const firestore = this._getFirestore();
		const jobs = new Map();
		const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
		const matches = (job) => (
			(!status || job.status === status)
			&& (!type || job.type === type)
			&& (telegramChatId === undefined || String(job.requestMetadata?.telegramChatId) === String(telegramChatId))
		);

		if (firestore) {
			try {
				let lastDoc;
				let lastDocId;
				let matchingJobs = 0;

				while (true) {
					let query = firestore.collection(COLLECTION_NAME);
					if (typeof query.where === 'function') {
						if (status) query = query.where('status', '==', status);
						if (telegramChatId !== undefined) {
							query = query.where('requestMetadata.telegramChatId', '==', String(telegramChatId));
						}
					}
					query = query.orderBy('createdAt', 'desc');
					query = query.limit(safeLimit);
					if (lastDoc) {
						query = query.startAfter(lastDoc);
					}

					const snapshot = await awaitWithAbort(query.get(), signal);
					const docs = snapshot?.docs || [];
					for (const doc of docs) {
						const data = doc.data() || {};
						const job = sanitizeJob({ ...data, jobId: data.jobId || doc.id });
						if (job?.jobId) {
							jobs.set(job.jobId, job);
							if (matches(job)) matchingJobs += 1;
						}
					}

					if (docs.length < safeLimit || matchingJobs >= safeLimit) {
						break;
					}

					const nextDoc = docs[docs.length - 1];
					if (!nextDoc || !nextDoc.id || nextDoc.id === lastDocId) {
						break;
					}
					lastDoc = nextDoc;
					lastDocId = nextDoc.id;
				}
				} catch (error) {
					if (error.name === 'AbortError') throw error;
					console.warn('[JobRepository] Failed to list jobs from Firestore:', error.message);
			}
		}

		for (const [jobId, job] of memoryJobs.entries()) {
			if (!jobs.has(jobId)) {
				jobs.set(jobId, cloneJob(job));
			}
		}

		return [...jobs.values()];
	}

	async delete(jobId) {
		if (!jobId) {
			return false;
		}

		let deleted = memoryJobs.delete(jobId);
		saveVersions.delete(jobId);
		pendingSaves.delete(jobId);
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(jobId).delete();
				deleted = true;
			} catch (error) {
				console.warn('[JobRepository] Failed to delete job from Firestore:', error.message);
			}
		}

		return deleted;
	}

	has(jobId) {
		return memoryJobs.has(jobId);
	}

	setMemory(jobId, job) {
		memoryJobs.set(jobId, cloneJob(job));
	}

	getMemory(jobId) {
		return cloneJob(memoryJobs.get(jobId));
	}

	entries() {
		return [...memoryJobs.entries()].map(([id, job]) => [id, cloneJob(job)]);
	}

	async getBacklogDepth({ maxScan = 100, maxPages = 5, now = Date.now() } = {}) {
		const firestore = this._getFirestore();

		if (firestore) {
			try {
				let query = firestore.collection(COLLECTION_NAME);
				// The page cap only bounds one sweep. Carry the last scanned document
				// across probes so a backlog sitting past the cap is not invisible
				// forever: the next sweep resumes after it, and once the suffix is
				// reached the cursor resets and the scan starts over from the front.
				// Without this, the oldest N documents would be rescanned every
				// probe and any queued job ordered after them would never be seen.
				let lastDoc = this._backlogScanCursor;
				let lastDocId = this._backlogScanCursorId;
				const scanEpoch = this._backlogScanEpoch;
				let rotatedFromCursor = Boolean(lastDoc);
				let durableQueuedCount = 0;
				let oldestCreatedAt = null;
				let truncated = false;

				for (let page = 0; page < maxPages; page += 1) {
					let pageQuery = query;
					if (typeof pageQuery.where === 'function') {
						pageQuery = pageQuery.where('status', '==', 'processing');
					}
					if (typeof pageQuery.orderBy === 'function') {
						pageQuery = pageQuery.orderBy('createdAt', 'asc');
					}
					if (typeof pageQuery.limit === 'function') {
						pageQuery = pageQuery.limit(maxScan);
					}
					if (lastDoc && typeof pageQuery.startAfter === 'function') {
						pageQuery = pageQuery.startAfter(lastDoc);
					}

					const snapshot = await pageQuery.get();
					const docs = snapshot?.docs || [];
					for (const doc of docs) {
						const data = doc.data() || {};
						const execution = data.execution || {};
						const isQueued = isQueuedExecution(execution, now);

						if (isQueued) {
							durableQueuedCount += 1;
							if (data.createdAt && (!oldestCreatedAt || Date.parse(data.createdAt) < Date.parse(oldestCreatedAt))) {
								oldestCreatedAt = data.createdAt;
							}
						}
					}

					if (docs.length < maxScan || typeof pageQuery.startAfter !== 'function') break;
					const nextDoc = docs[docs.length - 1];
					if (!nextDoc || !nextDoc.id || nextDoc.id === lastDocId) break;
					lastDoc = nextDoc;
					lastDocId = nextDoc.id;
					// A full page was scanned and more may remain; keep the counts a
					// lower bound rather than paginating the whole collection.
					if (page === maxPages - 1) truncated = true;
				}

				// Advance the rotation cursor for the next probe. truncated is only set
				// on the last allowed page, which is only reached once lastDoc and
				// lastDocId hold a real document, so no extra guard is needed. A sweep
				// that reached the end of the collection clears the cursor so the next
				// probe re-reads from the oldest document.
				//
				// A sweep that both resumed from a cursor and then reached the end has
				// covered the whole collection across two sweeps, so it reports
				// cycleComplete. Without it, a collection larger than the page cap
				// could never produce a sweep that proves recovery and the operator
				// incident would never clear.
				//
				// The commit is conditional on scanEpoch: the caller bumps it only when
				// it actually accepts a result. A scan abandoned at the caller's probe
				// deadline still resolves here, but by then the epoch has moved on, so
				// it leaves the cursor alone instead of skipping a window whose result
				// the caller discarded.
				const cycleComplete = !truncated && rotatedFromCursor;
				if (this._backlogScanEpoch === scanEpoch) {
					if (truncated) {
						this._backlogScanCursor = lastDoc;
						this._backlogScanCursorId = lastDocId;
					} else {
						this._backlogScanCursor = null;
						this._backlogScanCursorId = null;
					}
				}

				const oldestCreatedAtMs = oldestCreatedAt ? Date.parse(oldestCreatedAt) : null;
				const oldestQueuedAgeMs = Number.isFinite(oldestCreatedAtMs)
					? Math.max(0, now - oldestCreatedAtMs)
					: null;

				// A sweep that started past the front of the collection sees only part
				// of the backlog, so the reported age is a lower bound: an older
				// queued job may sit in the unscanned prefix and this probe cannot
				// see it. The age is never inflated (that would page on no evidence),
				// and the rotation flag makes the partial view explicit instead of
				// letting it read as a complete depth.
				return {
					durableQueuedCount,
					oldestQueuedAgeMs,
					oldestCreatedAt,
					truncated,
					scanRotated: rotatedFromCursor,
					cycleComplete,
					source: 'firestore',
				};
			} catch (error) {
				console.warn('[JobRepository] Failed to probe durable backlog depth from Firestore:', error.message);
				// Report the failure instead of silently degrading to the process-local
				// map. On a web replica that map is empty, so an empty result would be
				// indistinguishable from a genuinely drained backlog and could clear a
				// real active alert. The caller decides how to fail open.
				return {
					...this.getMemoryBacklogDepth(now),
					source: 'firestore-error',
					probeFailed: true,
				};
			}
		}

		// Firestore job storage is enabled but the client is unavailable: bad
		// credentials, a failed admin init, or a dependency that never resolved.
		// That is a broken dependency, not a drained queue. Falling through to the
		// process-local map would report zero on a freshly restarted web replica
		// and silently suppress the page for an unreadable backlog, so report an
		// indeterminate result instead. Intentionally disabled storage keeps using
		// the map, where an empty result really does mean empty.
		if (isFirestoreEnabled()) {
			return {
				durableQueuedCount: null,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
				truncated: false,
				source: 'firestore-unavailable',
				probeFailed: true,
			};
		}

		return { ...this.getMemoryBacklogDepth(now), source: 'memory', probeFailed: false };
	}

	// Re-read the oldest window of the collection, bypassing any rotation cursor.
	//
	// A rotation cycle that spans several probes is not a consistent snapshot: the
	// scan counts a `claimed`/`running` job whose lease has expired as queued, so a
	// job in the already-scanned prefix can become queued while the later windows are
	// still being read. By the time the tail reaches the end the cursor is cleared and
	// nothing re-reads that prefix, so the caller uses this to confirm it is still
	// drained before claiming recovery.
	//
	// Reads a single window rather than the whole collection: the point is to detect
	// that the prefix is no longer empty, not to re-derive a total depth, so a
	// `truncated` result here is expected and not an error.
	async getFrontBacklogDepth({ maxScan = 100, now = Date.now() } = {}) {
		const firestore = this._getFirestore();
		if (!firestore) {
			// Without Firestore the process-local map is the whole truth, and the
			// in-memory sweep that just ran already read all of it.
			return this.getMemoryBacklogDepth(now);
		}
		try {
			let query = firestore.collection(COLLECTION_NAME);
			if (typeof query.where === 'function') {
				query = query.where('status', '==', 'processing');
			}
			if (typeof query.orderBy === 'function') {
				query = query.orderBy('createdAt', 'asc');
			}
			if (typeof query.limit === 'function') {
				query = query.limit(maxScan);
			}
			const snapshot = await query.get();
			const docs = snapshot?.docs || [];
			let durableQueuedCount = 0;
			let oldestCreatedAt = null;
			// Whether the last row read is a claim that is still live. Rows sort by
			// createdAt ascending, so anything beyond this page is strictly newer —
			// and a live claim there could still expire into newly-queued work, which
			// is the hazard this re-read exists to catch. A last row that is finished
			// (or queued) cannot grow into anything, so the read is conclusive even
			// though the page was full.
			//
			// Note this is deliberately NOT `docs.length >= maxScan`: the query filters
			// on the top-level `status == 'processing'`, and every queued job is also
			// `processing`, so a full page of ordinary running jobs would otherwise
			// veto recovery permanently on any collection that big.
			let mayHideUnexpiredClaim = false;
			for (const doc of docs) {
				const data = doc.data() || {};
				const execution = data.execution || {};
				if (isQueuedExecution(execution, now)) {
					durableQueuedCount += 1;
					if (data.createdAt && (!oldestCreatedAt || Date.parse(data.createdAt) < Date.parse(oldestCreatedAt))) {
						oldestCreatedAt = data.createdAt;
					}
				}
				const leaseUntilMs = Date.parse(execution.leaseUntil || '');
				mayHideUnexpiredClaim = ['claimed', 'running'].includes(execution.status)
					&& Number.isFinite(leaseUntilMs)
					&& leaseUntilMs > now;
			}
			const oldestCreatedAtMs = oldestCreatedAt ? Date.parse(oldestCreatedAt) : null;
			return {
				durableQueuedCount,
				oldestCreatedAt,
				oldestQueuedAgeMs: Number.isFinite(oldestCreatedAtMs)
					? Math.max(0, now - oldestCreatedAtMs)
					: null,
				truncated: mayHideUnexpiredClaim,
				source: 'firestore',
			};
		} catch (error) {
			console.warn('[JobRepository] Failed to revalidate the backlog front:', error.message);
			// The caller must treat this as unproven rather than empty, so it reports
			// the failure rather than falling back to the process-local map.
			return {
				durableQueuedCount: null,
				oldestQueuedAgeMs: null,
				oldestCreatedAt: null,
				truncated: false,
				source: 'firestore-error',
				probeFailed: true,
			};
		}
	}

	getMemoryBacklogDepth(now = Date.now()) {
		let durableQueuedCount = 0;
		let oldestCreatedAt = null;

		for (const job of memoryJobs.values()) {
			if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
			const execution = job.execution || {};
			const isQueued = isQueuedExecution(execution, now);

			if (isQueued) {
				durableQueuedCount += 1;
				if (job.createdAt) {
					if (!oldestCreatedAt || Date.parse(job.createdAt) < Date.parse(oldestCreatedAt)) {
						oldestCreatedAt = job.createdAt;
					}
				}
			}
		}

		const oldestCreatedAtMs = oldestCreatedAt ? Date.parse(oldestCreatedAt) : null;
		const oldestQueuedAgeMs = Number.isFinite(oldestCreatedAtMs)
			? Math.max(0, now - oldestCreatedAtMs)
			: null;

		return {
			durableQueuedCount,
			oldestQueuedAgeMs,
			oldestCreatedAt,
		};
	}

	_getFirestore() {
		if (!isFirestoreEnabled()) {
			return null;
		}
		return alertStorageService.getFirestore();
	}
}

const jobRepository = new JobRepository();

module.exports = {
	JobRepository,
	jobRepository,
	COLLECTION_NAME,
	_resetForTesting() {
		memoryJobs.clear();
		saveVersions.clear();
		pendingSaves.clear();
		firestoreWriteMetricsService.resetForTesting();
		jobRepository._backlogScanCursor = null;
		jobRepository._backlogScanCursorId = null;
	},
};
