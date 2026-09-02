/**
 * Charts singleton - process-wide ChartRenderer instance.
 *
 * The renderer is created once at module load. It reads its timeouts and cache
 * settings from process.env (which the Remote Config service may have
 * overridden before the first request). The singleton is intentionally
 * simple: there is no plugin manager, no hot reload, and no external
 * configuration source. The /api/status endpoint reads its redacted snapshot
 * via getStatus().
 *
 * Tests instantiate ChartRenderer directly to avoid leaking state through
 * the singleton.
 */

'use strict';

const ChartRenderer = require('./chartRenderer');

const chartRenderer = new ChartRenderer();

module.exports = {
	chartRenderer,
	ChartRenderer,
};
