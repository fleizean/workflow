# Contributing to Workflow Timer

First off, thank you for considering contributing to Workflow Timer! 🎉

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues. When creating a bug report, include:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples**
- **Describe the behavior you observed and what you expected**
- **Include screenshots if possible**
- **Specify your OS and Electron version**

### Suggesting Features

Feature suggestions are welcome! Please:

- **Use a clear and descriptive title**
- **Provide a detailed description of the suggested feature**
- **Explain why this feature would be useful**
- **Include mockups or examples if applicable**

### Pull Requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Test your changes thoroughly
4. Update the README.md if needed
5. Ensure your code follows the existing style
6. Write clear commit messages
7. Submit a pull request!

## Development Setup

1. Clone your fork:
   ```bash
   git clone https://github.com/your-username/workflow-timer.git
   cd workflow-timer
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the app:
   ```bash
   npm start
   ```

## Code Style

- Use meaningful variable and function names
- Comment complex logic
- Keep functions focused and small
- Follow existing code patterns

## Database Changes

If you modify the database schema:
- Update the `initDatabase()` function in `database/db.js`
- Consider migration for existing users
- Document the changes

## Testing

Before submitting:
- Test all modified functionality
- Test on different screen sizes
- Check for console errors
- Verify database operations work correctly

## Questions?

Feel free to open an issue with your question or reach out to the maintainers.

Thank you for contributing! 🙏
