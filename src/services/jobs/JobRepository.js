'use strict';

const alertStorageService = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'tradingviewJobs';
const memoryJobs = new Map();

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

class JobRepository {
	async save(job) {
		const sanitized = sanitizeJob(job);
		if (!sanitized || !sanitized.jobId) {
			return null;
		}

		memoryJobs.set(sanitized.jobId, cloneJob(sanitized));

		const firestore = this._getFirestore();
		if (!firestore) {
			return sanitized.jobId;
		}

		try {
			await firestore.collection(COLLECTION_NAME).doc(sanitized.jobId).set(sanitized);
		} catch (error) {
			console.warn('[JobRepository] Failed to persist job:', error.message);
		}

		return sanitized.jobId;
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

	async list() {
		const firestore = this._getFirestore();
		const jobs = new Map();

		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).get();
				for (const doc of snapshot?.docs || []) {
					const data = doc.data() || {};
					const job = sanitizeJob({ ...data, jobId: data.jobId || doc.id });
					if (job?.jobId) {
						jobs.set(job.jobId, job);
					}
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
