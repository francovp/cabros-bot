/* global document, window, innerWidth */
// With /admin open locally: playwright-cli run-code --filename=scripts/check-admin-browser.js
// API requests are intercepted; this check never delivers alerts or submits orders.
async (page) => {
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('**/api/**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				success: true,
				items: [{ symbol: 'BTCUSDT', price: '0.1234567890123456789', active: true }],
				message: '<img src=x onerror=alert(1)>',
				callbackSecret: 'not-for-display',
			}),
		}),
	)
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.reload()
	await page.getByRole('button', { name: 'Operations', exact: true }).click()
	const select = page.locator('select[name=operation]')
	const options = await select
		.locator('option')
		.evaluateAll((nodes) => nodes.map((n) => ({ value: n.value, text: n.textContent })))
	let visited = 0
	for (const option of options) {
		await select.selectOption(option.value)
		await page.evaluate(() => window.Vue.nextTick())
		if (await page.locator('textarea[name=body],textarea[name=query]').count())
			throw new Error('Raw editor on ' + option.text)
		visited++
	}
	await select.selectOption(options.find((o) => o.text.startsWith('POST /api/jobs/tradingview-analysis ')).value)
	await page.getByRole('textbox', { name: 'Request options extra field name', exact: true }).fill('operatorNote')
	await page.getByRole('button', { name: 'Add field', exact: true }).last().click()
	await page.getByRole('textbox', { name: 'Operator Note', exact: true }).fill('Keep this edit')
	await page.getByRole('combobox', { name: 'Timeframe', exact: true }).selectOption('4h')
	if (
		(await page.locator('input[name=body]').evaluate((el) => JSON.parse(el.value).operatorNote)) !==
		'Keep this edit'
	)
		throw new Error('Changing a field discarded another edit')
	await page.getByRole('combobox', { name: 'Type *', exact: true }).selectOption('market-scanner')
	const switched = await page.locator('input[name=body]').evaluate((el) => JSON.parse(el.value))
	if (switched.operatorNote !== 'Keep this edit' || switched.symbols !== undefined)
		throw new Error('Job variant lost custom fields or retained incompatible fields')
	await select.selectOption(options.find((o) => o.text.startsWith('POST /api/webhook/alert ')).value)
	await page.getByRole('textbox', { name: 'Text *', exact: true }).fill('Visual roundtrip')
	const expected = await page.locator('input[name=body]').evaluate((el) => JSON.parse(el.value))
	if (expected.text !== 'Visual roundtrip') throw new Error('Editor did not synchronize payload')
	await select.selectOption(options.find((o) => o.text.startsWith('GET /api/status ')).value)
	await select.selectOption(options.find((o) => o.text.startsWith('POST /api/webhook/alert ')).value)
	if ((await page.getByRole('textbox', { name: 'Text *', exact: true }).inputValue()) !== 'Visual roundtrip')
		throw new Error('Cached edit lost')
	const request = page.waitForRequest((r) => r.url().includes('/api/webhook/alert') && r.method() === 'POST')
	await page.getByRole('button', { name: 'Send request', exact: true }).click()
	const submitted = await request
	if (submitted.postDataJSON().text !== 'Visual roundtrip') throw new Error('Wrong submitted payload')
	await page.locator('cabros-result table').waitFor()
	const result = await page.locator('cabros-result').first().innerText()
	if (result.includes('not-for-display')) throw new Error('Secret exposed')
	if (await page.locator('cabros-result img').count()) throw new Error('Unsafe HTML rendered')
	await page.setViewportSize({ width: 390, height: 844 })
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
	if (overflow) throw new Error('Mobile viewport overflows')
	if ((await page.locator('.console-sidebar').boundingBox()).height > 250) throw new Error('Mobile navigation leaves an empty viewport')
	if (errors.length) throw new Error(errors.join('; '))
	await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0) })
	await page.screenshot({ path: 'output/playwright/admin-mobile.png', fullPage: true })
	await page.setViewportSize({ width: 1280, height: 900 })
	await page.screenshot({ path: 'output/playwright/admin-desktop.png', fullPage: true })
	return {
		visited,
		requestRoundtrip: true,
		cachedInputs: true,
		structuredResponse: true,
		safeText: true,
		mobileWidth: 390,
	}
}
