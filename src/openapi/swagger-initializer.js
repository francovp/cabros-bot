'use strict';

window.addEventListener('load', () => {
	window.ui = SwaggerUIBundle({
		url: '/openapi.json',
		dom_id: '#swagger-ui',
		deepLinking: true,
		displayRequestDuration: true,
		presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
		layout: 'StandaloneLayout',
		persistAuthorization: false,
	});
});
