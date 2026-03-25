# Nashville Trip PWA

This is a static, phone-first Nashville trip app meant to be pinned to a home screen.

## What it does

- Shows each trip day as a tap-friendly agenda.
- Pulls live updates from your published Google Sheets itinerary and planning tabs.
- Gives you quick neighborhood-aware pivot and nearby links.
- Opens directions, map searches, and review searches in Google.
- Works well as a lightweight PWA once hosted on GitHub Pages.

## Local preview

```bash
cd /Users/caseyho/Codex/nashville-trip-pwa
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## GitHub Pages Setup

If you are new to GitHub, this is the easiest path:

1. Create a GitHub account at `https://github.com/`.
2. Create a new empty repository. A good name would be `nashville-trip-app`.
3. In Terminal, run:

```bash
cd /Users/caseyho/Codex/nashville-trip-pwa
git init
git branch -M main
git add .
git commit -m "Initial Nashville trip app"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

4. On GitHub, open the repo.
5. Go to `Settings` -> `Pages`.
6. Under `Build and deployment`, choose:
   - `Source`: `Deploy from a branch`
   - `Branch`: `main`
   - `Folder`: `/ (root)`
7. Save.

After a minute or two, GitHub will publish your site at:

`https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPO_NAME/`

## Phone install

On iPhone:

1. Open the GitHub Pages URL in Safari.
2. Tap `Share`.
3. Tap `Add to Home Screen`.

## Data config

The live sheet URLs are stored in `data/sheet-config.json`.

If you ever change tabs or publish new Google Sheets links, update that file and push again.

## Optional future improvements

- Add a small password gate
- Add custom icons
- Add richer map/review integration with Places APIs
