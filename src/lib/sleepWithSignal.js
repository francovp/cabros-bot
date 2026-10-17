function sleepWithSignal(ms, signal) {
	if (!signal) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	if (signal.aborted) {
		return Promise.reject(new Error(signal.reason?.message || signal.reason || 'Operation aborted'));
	}
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeoutId);
			signal.removeEventListener('abort', onAbort);
			reject(new Error(signal.reason?.message || signal.reason || 'Operation aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

module.exports = sleepWithSignal;
