# Workflow Timer ⏱️

<div align="center">

![Workflow Timer Logo](assets/workflow-timer.png)

**Modern work time tracking desktop application**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Electron](https://img.shields.io/badge/Electron-28.0-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](https://github.com/fleizean/workflow-timer)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Development](#development)

</div>

---

## 📋 Overview

Workflow Timer is a beautiful, minimalist desktop application for tracking your work hours. Built with Electron and SQLite, it helps you stay motivated with streak tracking, daily targets, and detailed work session history.

## ✨ Features

### 🎯 Core Features
- **Timer Management**: Start, pause, and adjust your work sessions with ease
- **Daily Target**: Set and track your daily work hour goals
- **Work History**: View all past sessions with filtering and search
- **Streak Tracking**: 🔥 Monitor consecutive days of reaching your daily target
- **Session Management**: Save, edit, and delete work sessions with custom names

### 🎨 Design
- **Modern UI**: Clean, dark-mode interface with smooth animations
- **Frameless Window**: Custom title bar for a native app feel
- **Responsive**: Optimized mobile-style layout (430x932px)
- **Interactive Cards**: Hover effects and visual feedback

### 🔔 Notifications
- **Goal Achievement**: Sound and visual notifications when daily target is reached
- **Congratulations Modal**: Celebrate your productivity milestones

### 💾 Data Management
- **SQLite Database**: Fast, local data storage
- **Persistent Storage**: Data is preserved across app updates
- **Settings**: Customizable daily targets and notification preferences

## 🚀 Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher)
- npm (comes with Node.js)

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/fleizean/workflow-timer.git
   cd workflow-timer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the application**
   ```bash
   npm start
   ```

### Building for Production

To create a distributable executable:

```bash
npm run build
```

The built application will be in the `dist_output/` directory.

## 💻 Development

### Project Structure

```
workflow-timer/
├── src/
│   ├── pages/           # HTML pages
│   │   ├── index.html   # Main timer page
│   │   ├── work-history.html
│   │   └── settings.html
│   ├── renderer/        # Frontend JavaScript
│   │   ├── timer.js
│   │   ├── shared.js
│   │   └── tailwind-config.js
│   ├── styles/          # CSS files
│   │   ├── common.css
│   │   └── titlebar.css
│   └── assets/          # Images and sounds
├── database/
│   └── db.js           # SQLite database logic
├── main.js             # Electron main process
├── preload.js          # IPC bridge
└── package.json
```

### Technologies Used

- **[Electron](https://www.electronjs.org/)** - Desktop application framework
- **[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)** - Fast SQLite database
- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[Material Symbols](https://fonts.google.com/icons)** - Icon library

### Key Scripts

```bash
npm start          # Run in development mode
npm run build      # Build for Windows
npm run build:dir  # Build unpacked directory
```

## 📖 Usage

### Starting a Work Session

1. Click the **Play** button to start tracking time
2. The timer will count up and show your remaining time to reach the daily target
3. Click **Pause** to temporarily stop the timer
4. Use **Adjust** to manually add or remove time

### Saving Sessions

1. Click the **Save** button
2. Enter a custom name for your session (e.g., "Frontend Development")
3. Confirm to save - the session is added to your history

### Tracking Your Streak

- Your streak shows consecutive days where you've reached your daily target
- Weekends are included in the streak calculation
- Missing a day resets your streak to 0

### Viewing History

1. Click on the **Logged** card on the main screen
2. Browse your past sessions grouped by week
3. Use filters to find specific sessions
4. Edit or delete sessions as needed

## 🎯 Roadmap

- [ ] Export data to CSV/JSON
- [ ] Statistics dashboard with charts
- [ ] Pomodoro timer mode
- [ ] Multi-language support
- [ ] Custom themes
- [ ] Excelsheet sync?

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👨‍💻 Author

**Workflow Timer Team**
- Website: [fleizean.dev](https://www.fleizean.dev)

## 🙏 Acknowledgments

- Icons by [Material Symbols](https://fonts.google.com/icons)
- Font: [Inter](https://fonts.google.com/specimen/Inter) by Rasmus Andersson
- Inspired by modern productivity tools

---

<div align="center">

Made with ❤️ and ⏱️ by Workflow Timer Team

[⬆ Back to Top](#workflow-timer-️)

</div>