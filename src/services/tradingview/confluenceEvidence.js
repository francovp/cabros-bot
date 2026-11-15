function hasPositiveEvidence(value) {
	if (Array.isArray(value)) return value.length > 0;

	const count = typeof value === 'number'
		? value
		: typeof value === 'string' && value.trim() ? Number(value) : 0;
	return Number.isFinite(count) && count > 0;
}

function hasConfluenceEvidence(analysis = {}) {
	const news = analysis.news || {};
	const sentiment = analysis.sentiment || analysis.market_sentiment || {};
	const reddit = analysis.reddit || {};

	return [
		news.count,
		news.latest,
		analysis.posts_analyzed,
		sentiment.posts_analyzed,
		sentiment.posts,
		reddit.posts_analyzed,
		reddit.posts,
	].some(hasPositiveEvidence);
}

module.exports = { hasConfluenceEvidence };
