# Contributing to Cabros Bot

Thank you for considering contributing to Cabros Bot! We appreciate your help in making this project better.

## How to Contribute

There are several ways you can contribute to this project:

1. **Reporting Bugs**: If you find a bug, please open an issue with detailed information about how to reproduce it.
2. **Suggesting Features**: Have an idea for a new feature? Open an issue to discuss it before implementing.
3. **Improving Documentation**: Found unclear or missing documentation? Feel free to improve it.
4. **Submitting Pull Requests**: Want to fix a bug or add a feature? Submit a pull request.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/cabros-bot.git
   ```
3. Create a new branch for your changes:
   ```bash
   git checkout -b feature-or-fix-name
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Make your changes
6. Ensure your code follows the project's coding standards
7. Test your changes thoroughly
8. Commit your changes:
   ```bash
   git commit -am "Describe your changes"
   ```
9. Push to your fork:
   ```bash
   git push origin feature-or-fix-name
   ```
10. Submit a pull request to the main repository

## Development Setup

To set up the development environment:

1. Install Node.js (version 20.x as specified in package.json)
2. Install dependencies: `npm install`
3. Create a `.env` file based on `.env.example`
4. Run the development server: `npm run start-dev`

## Code Style

Please follow the existing code style in the project. We use ESLint for linting, which you can run with:

```bash
npm run lint
```

To automatically fix linting issues:

```bash
npm run lint:fix
```

## Pull Request Process

1. Ensure your code passes all tests and linting checks
2. Update documentation as needed
3. Keep your pull request focused on a single change or feature
4. Write clear, descriptive commit messages
5. Be responsive to feedback and questions from maintainers

## Reporting Bugs

When reporting a bug, please include:
- A clear and descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Any relevant screenshots or logs
- Your environment details (Node.js version, OS, etc.)

## Feature Requests

When requesting a feature, please include:
- A clear and descriptive title
- A detailed description of the feature
- Why this feature would be useful
- Any potential implementation considerations

## License

By contributing to Cabros Bot, you agree that your contributions will be licensed under the project's ISC license.