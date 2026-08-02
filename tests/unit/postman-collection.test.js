const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, '../../CabrosBot.postman_collection.json');

function findItem(items, name) {
	for (const item of items) {
		if (item.name === name) return item;
		if (Array.isArray(item.item)) {
			const match = findItem(item.item, name);
			if (match) return match;
		}
	}
	return undefined;
}

describe('Postman collection contract', () => {
	it('documents x-idempotency-key on the alert webhook request', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const sendAlert = findItem(collection.item, 'POST Send Alert');

		expect(sendAlert).toBeDefined();
		expect(sendAlert.request.header).toEqual(expect.arrayContaining([
			expect.objectContaining({
				key: 'x-idempotency-key',
				disabled: true,
			}),
		]));
	});
});
