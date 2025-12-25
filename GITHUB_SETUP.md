# Krono - GitHub Setup Guide

## 📋 Checklist for GitHub Upload

### Files Created ✅
- [x] `.gitignore` - Ignores node_modules, build outputs, database files
- [x] `README.md` - Comprehensive project documentation
- [x] `LICENSE` - MIT License
- [x] `CONTRIBUTING.md` - Contribution guidelines
- [x] `screenshots/README.md` - Instructions for adding screenshots

### Before Pushing to GitHub

1. **Add Screenshots** (Optional but recommended)
   ```bash
   # Take screenshots of the app and add to screenshots/ folder
   # Update README.md image links if you add them
   ```

2. **Update README.md Links**
   - Replace `fleizean` with your actual GitHub username in all links
   - Example: `https://github.com/fleizean/workflow-timer` → `https://github.com/fleizean/workflow-timer`

3. **Review package.json**
   - Update `author` field if needed
   - Verify `repository` URL (add if missing)

4. **Test the Build**
   ```bash
   npm install
   npm start
   npm run build
   ```

### Git Commands to Upload

```bash
# 1. Initialize git repository (if not already done)
git init

# 2. Add all files
git add .

# 3. Create initial commit
git commit -m "Initial commit: Krono work timer application"

# 4. Add GitHub remote (replace with your repo URL)
git remote add origin https://github.com/fleizean/workflow-timer.git

# 5. Push to GitHub
git branch -M main
git push -u origin main
```

### After Uploading

1. **Add Topics/Tags** on GitHub:
   - electron
   - desktop-app
   - time-tracker
   - productivity
   - sqlite
   - tailwindcss

2. **Add Description**: "Modern work time tracking desktop application built with Electron"

3. **Enable Issues/Discussions** if you want community contributions

4. **Add GitHub Actions** (Optional):
   - Auto-build on commits
   - Release automation

## 🎯 What's Excluded from Git

The `.gitignore` file excludes:
- `node_modules/` - Will be installed via `npm install`
- `dist_output/` - Build outputs
- `*.db` files - Local database files
- OS-specific files (.DS_Store, Thumbs.db)
- IDE folders (.vscode, .idea)

## 📸 Optional: Adding Screenshots

1. Run the app and take screenshots
2. Add them to `screenshots/` folder
3. Update README.md image links:

```markdown
### Main Timer Screen
![Main Screen](screenshots/main-screen.png)

### Work History
![Work History](screenshots/work-history.png)
```

## 🚀 Quick Start for New Contributors

After your repo is on GitHub, contributors can:

```bash
git clone https://github.com/fleizean/workflow-timer.git
cd workflow-timer
npm install
npm start
```

---

**Ready to push to GitHub!** 🎉
