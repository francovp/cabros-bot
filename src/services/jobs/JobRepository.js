'use strict';

const alertStorageService = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'tradingviewJobs';
const memoryJobs = new Map();
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const DEFAULT_CLAIM_LEASE_MS = 60000;

function cloneJob(job) {
	if (!job) return null;
	return JSON.parse(JSON.stringify(job));
}

function isFirestoreEnabled() {
	return process.env.ENABLE_FIRESTORE_JOB_STORAGE === 'true'
		|| process.env.ENABLE_FIRESTORE_ALERT_STORAGE === 'true';
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

function getClaimLeaseMs() {
	const configured = Number(process.env.JOB_QUEUE_CLAIM_LEASE_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_CLAIM_LEASE_MS;
}

class JobRepository {
	async save(job, { required = false } = {}) {
		const sanitized = sanitizeJob(job);
		if (!sanitized || !sanitized.jobId) {
			return null;
		}

		const firestore = this._getFirestore();
		if (!firestore) {
			memoryJobs.set(sanitized.jobId, cloneJob(sanitized));
			return sanitized.jobId;
		}

		try {
			if (typeof firestore.runTransaction === 'function') {
				const docRef = firestore.collection(COLLECTION_NAME).doc(sanitized.jobId);
				const saved = await firestore.runTransaction(async (transaction) => {
					const snapshot = await transaction.get(docRef);
					if (snapshot && snapshot.exists) {
						const current = sanitizeJob({ ...(snapshot.data() || {}), jobId: snapshot.id || sanitized.jobId });
						const incomingWorkerId = sanitized.execution && sanitized.execution.workerId;
						const currentExecution = current && current.execution ? current.execution : {};
						const currentClaimIsActive = currentExecution.workerId
							&& ['claimed', 'running'].includes(currentExecution.status);
						if (currentClaimIsActive && !incomingWorkerId && !TERMINAL_STATUSES.has(sanitized.status)) {
							return false;
						}
						if (incomingWorkerId && (!current || (current.execution || {}).workerId !== incomingWorkerId)) {
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
						if (current && TERMINAL_STATUSES.has(current.status) && current.status !== sanitized.status) {
							return false;
						}
					}

					transaction.set(docRef, sanitized);
					return true;
				});
				if (saved === false) {
					return null;
				}
			} else {
				await firestore.collection(COLLECTION_NAME).doc(sanitized.jobId).set(sanitized);
			}
		} catch (error) {
			console.warn('[JobRepository] Failed to persist job:', error.message);
			if (required) {
				memoryJobs.delete(sanitized.jobId);
				const storageError = new Error('Durable job storage is unavailable.');
				storageError.code = 'JOB_STORAGE_UNAVAILABLE';
				throw storageError;
			}
		}

		memoryJobs.set(sanitized.jobId, cloneJob(sanitized));
		return sanitized.jobId;
	}

	async updateCallbackStatus(jobId, event, callbackUpdate = {}) {
		if (!jobId || !event) {
			return false;
		}

		const merge = (job) => {
			const existingStatus = job.callbackStatus || {};
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
							status: callbackUpdate.status,
							attempts,
						},
					},
				},
				updatedAt: new Date().toISOString(),
			};
		};

		const firestore = this._getFirestore();
		if (firestore) {
			if (typeof firestore.runTransaction !== 'function') {
				return false;
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
					transaction.set(docRef, nextJob);
					memoryJobs.set(jobId, cloneJob(nextJob));
					return true;
				});
			} catch (error) {
				console.warn('[JobRepository] Failed to persist callback status:', error.message);
				return false;
			}
		}

		const current = await this.get(jobId);
		if (!current) {
			return false;
		}

		await this.save(merge(current));
		return true;
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
						mode: 'render-worker',
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
					|| TERMINAL_STATUSES.has(current.status)
					|| !['claimed', 'running'].includes(execution.status)
					|| execution.workerId !== workerId
					|| (attempt !== null && attempt !== undefined && Number(execution.attempt) !== Number(attempt))
				) {
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
				transaction.set(docRef, nextJob);
				memoryJobs.set(jobId, cloneJob(nextJob));
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

	async get(jobId) {
		if (!jobId) {
			return null;
		}

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).doc(jobId).get();
				if (snapshot && snapshot.exists) {
					const data = snapshot.data() || {};
					const job = { ...data, jobId: data.jobId || snapshot.id };
					memoryJobs.set(job.jobId, cloneJob(job));
					return cloneJob(job);
				}
			} catch (error) {
				console.warn('[JobRepository] Failed to read job from Firestore:', error.message);
			}
		}

		return cloneJob(memoryJobs.get(jobId));
	}

	async list({ status, type, limit = 50 } = {}) {
		const firestore = this._getFirestore();
		const jobs = new Map();
		const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 50;
		const matches = (job) => (!status || job.status === status) && (!type || job.type === type);

		if (firestore) {
			try {
				let lastDoc;
				let lastDocId;
				let matchingJobs = 0;

				while (true) {
					let query = firestore
						.collection(COLLECTION_NAME)
						.orderBy('createdAt', 'desc')
						.limit(safeLimit);
					if (lastDoc) {
						query = query.startAfter(lastDoc);
					}

					const snapshot = await query.get();
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
	},
};
