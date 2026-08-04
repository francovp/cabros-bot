'use strict';

const alertStorageService = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'tradingviewJobs';
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const memoryJobs = new Map();
const saveVersions = new Map();
const pendingSaves = new Map();

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
	return copy;
}

async function getLocalTerminalJob(jobId) {
	while (true) {
		const localJob = saveVersions.get(jobId)?.job || memoryJobs.get(jobId);
		if (!localJob || !TERMINAL_JOB_STATUSES.has(localJob.status)) {
			return null;
		}

		const pending = pendingSaves.get(jobId);
		if (!pending?.size) {
			return cloneJob(localJob);
		}

		await Promise.allSettled([...pending]);
	}
}

class JobRepository {
	async _writeToFirestore(firestore, job) {
		try {
			await firestore.collection(COLLECTION_NAME).doc(job.jobId).set(job);
		} catch (error) {
			console.warn('[JobRepository] Failed to persist job:', error.message);
		}
	}

	async save(job) {
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

		memoryJobs.set(sanitized.jobId, cloneJob(sanitized));

		const firestore = this._getFirestore();
		if (!firestore) {
			return sanitized.jobId;
		}

		const version = (saveVersions.get(sanitized.jobId)?.version || 0) + 1;
		saveVersions.set(sanitized.jobId, { version, job: cloneJob(sanitized) });
		const persistencePromise = (async () => {
			await this._writeToFirestore(firestore, sanitized);

			let persistedVersion = version;
			let latest = saveVersions.get(sanitized.jobId);
			while (latest && latest.version > persistedVersion) {
				persistedVersion = latest.version;
				await this._writeToFirestore(firestore, latest.job);
				latest = saveVersions.get(sanitized.jobId);
			}
		})();
		const pending = pendingSaves.get(sanitized.jobId) || new Set();
		pending.add(persistencePromise);
		pendingSaves.set(sanitized.jobId, pending);
		try {
			await persistencePromise;
		} finally {
			pending.delete(persistencePromise);
			if (!pending.size) {
				pendingSaves.delete(sanitized.jobId);
			}
		}

		return sanitized.jobId;
	}

	async get(jobId) {
		if (!jobId) {
			return null;
		}

		const localJob = saveVersions.get(jobId)?.job || memoryJobs.get(jobId);
		if (localJob && TERMINAL_JOB_STATUSES.has(localJob.status) && pendingSaves.has(jobId)) {
			await getLocalTerminalJob(jobId);
		}

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).doc(jobId).get();
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
			jobs.set(jobId, cloneJob(job));
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
	},
};
