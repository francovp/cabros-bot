const express = require('express');

const app = express();
const cors = require('cors');
const helmet = require('helmet');

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Tell express to use body-parser's JSON and text parsing
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

// Configurar Cabeseras y CORS
app.use(cors());

// Use helmet for improved security
app.use(helmet());

app.use('/healthcheck', require('express-healthcheck')());

// Rate Limiter (must be after healthcheck to avoid limiting health checks)
app.use(require('./src/lib/rateLimiter'));

module.exports = app;

