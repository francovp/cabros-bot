const { round10 } = require('../../../helpers');
const { MainClient } = require('binance');

const client = new MainClient({
	// Optional (default: false) - when true, response strings are parsed to floats (only for known keys).
	beautifyResponses: true,
});

const fetchSymbolPrice = async (context) => {
	// Check for parameters;
	const messageSplited = context.message.text.split(' ');
	const symbol = messageSplited[1];
	try {
		let price;
		const data = await client.getAvgPrice({ symbol: symbol });
		// The prices have been successfully retrieved
		// So build the response object to trigger the success intent
		if (data.price >= 1) {
			price = round10(data.price, 0);
		} else {
			price = data.price;
		}

		// Resolve the Promise to say that the handler performed the action without any error
		return Promise.resolve({
			price: price,
			symbol: symbol,
		});
	} catch (e) {
		// An error occurred during the request to the API
		// Log the specific error message for better debugging
		console.error('Error fetching symbol price:', e);
		// Reject the Promise to say that an error occurred while the handler was performing the action
		return Promise.reject(e);
	}
};

module.exports = { fetchSymbolPrice };

