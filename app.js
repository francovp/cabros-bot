const express = require('express');

const app = express();
const cors = require('cors');
const helmet = require('helmet');
const rateLimiter = require('./src/lib/rateLimiter');

// Tell express to use body-parser's urlencoded parsing
app.use(express.urlencoded({ extended: false }));
// Tell express to use body-parser's JSON and text parsing
app.use(express.text({ type: 'text/plain' }));
app.use(express.json());

// Configurar Cabeseras y CORS
app.use(cors());

// Use helmet for improved security
app.use(helmet());

// Apply rate limiter to all requests
app.use(rateLimiter);

app.use('/healthcheck', require('express-healthcheck')());

module.exports = app;

