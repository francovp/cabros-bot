const fs = require('fs');
const path = require('path');

const DEFAULT_PROMPTS_DIR = path.join(__dirname, 'defaults');
const promptFileCache = new Map();

function readPromptFile(fileName) {
	if (!promptFileCache.has(fileName)) {
		const filePath = path.join(DEFAULT_PROMPTS_DIR, fileName);
		const contents = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
		promptFileCache.set(fileName, contents);
	}

	return promptFileCache.get(fileName);
}

function renderPromptTemplate(template, variables = {}) {
	return template
		.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, variableName) => {
			const value = variables[variableName];
			return value === undefined || value === null ? '' : String(value);
		})
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function getPromptFileTemplate(fileName, { envVar, variables = {} } = {}) {
	const source = envVar && process.env[envVar]
		? process.env[envVar]
		: readPromptFile(fileName);

	return renderPromptTemplate(source, variables);
}

function resetPromptFileCacheForTests() {
	promptFileCache.clear();
}

module.exports = {
	DEFAULT_PROMPTS_DIR,
	readPromptFile,
	renderPromptTemplate,
	getPromptFileTemplate,
	resetPromptFileCacheForTests,
};