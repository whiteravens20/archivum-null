# Branding

You can give an instance its own name, tagline, accent colour, theme, logo and icons without rebuilding anything. Text and colours are set in `.env`; images go into a `branding/` directory. Both are read when the server starts, so **restart after every change**.

An instance with none of this configured looks exactly as it always did.

![The light theme on the left; a custom name, tagline, accent colour and logo on the right](img/branding-examples.png)

## Table of Contents

- [Quick start](#quick-start)
- [Settings](#settings)
- [Accent colour](#accent-colour)
- [Theme](#theme)
- [Logo and icons](#logo-and-icons)
- [What does not change](#what-does-not-change)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

## Quick start

### Docker

1. Add the settings you want to `.env`:

   ```bash
   BRAND_NAME=Acme Drop
   BRAND_TAGLINE=Files, sealed and gone
   BRAND_ACCENT_COLOR=#F97316
   BRAND_THEME=auto
   ```

   Write the values as they are: no quotes, and no comment after a value on the same line.

2. For your own logo or icons, create a `branding` directory next to `docker-compose.yml`, put the files in it (the names are [listed below](#logo-and-icons)) and uncomment the volume in `docker-compose.yml`:

   ```yaml
   volumes:
     - vault-data:/data/vaults
     - ./TOS.md:/app/TOS.md:ro
     - ./branding:/app/branding:ro
   ```

3. Recreate the container:

   ```bash
   docker compose up -d
   ```

   `docker compose restart` is enough after changing a file in `branding/`, but it does not re-read `.env`. After changing `.env`, use `up -d`.

### Bare metal and Proxmox LXC

1. Add the same settings to the environment file of the service (`/opt/archivum-null/.env` in the LXC install).
2. Put your images into `/opt/archivum-null/branding/`. The directory does not exist until you create it.
3. Restart the service:

   ```bash
   systemctl restart archivum-null
   ```

Updating the installation rebuilds the frontend and leaves `branding/` and `.env` alone.

## Settings

| Variable | Default | Description |
|---|---|---|
| `BRAND_NAME` | `Archivum Null` | The name in the browser tab, in the heading of the home and vault pages, in the footer and in the web app manifest. 1 to 64 characters. |
| `BRAND_TAGLINE` | `Zero trust file relay` | The line under the name on the home page and at the end of the footer. It is also used in the page description. 1 to 120 characters. |
| `BRAND_ACCENT_COLOR` | `#60A5FA` | The accent colour, as six hex digits. See [Accent colour](#accent-colour). |
| `BRAND_THEME` | `dark` | `dark`, `light` or `auto`. See [Theme](#theme). |
| `BRANDING_PATH` | `branding` in the install directory (`/app/branding` in the image) | Where the server looks for your logo and icons. You only need this if the default location does not suit you. |

A value that fails its check stops the server at startup, with a message that names the variable. Nothing is applied half-way.

The name and the tagline may contain any printable characters, including accented letters and emoji. They are always shown as text, never interpreted as HTML.

## Accent colour

The accent is the colour of the main buttons, the progress bars and the highlighted text.

- Give it as `#RRGGBB`. Colour names, three-digit hex and `rgb()` are rejected.
- The text on a button is chosen for you: dark on a light accent, white on a dark one.
- In the **dark theme** the accent is also the colour of links and other highlighted text, so pick one that can be read on a near-black page (`#0B0F19`). If it cannot, the server says so at startup and starts anyway.
- In the **light theme** text and lines use a darkened form of your accent automatically, because most accents are too light to read on a light page. Buttons keep the colour as you set it.

## Theme

| Value | What visitors see |
|---|---|
| `dark` | The dark theme. This is the default. |
| `light` | The light theme. |
| `auto` | Light for visitors whose system is set to a light colour scheme, dark for everyone else. |

There is no switch on the page. `auto` is decided by the browser from the visitor's system setting, in CSS alone, so nothing has to be stored in the browser to remember a choice.

## Logo and icons

Put files with these exact names into the branding directory. Each one replaces the built-in image; whatever you leave out stays built-in.

| File | Replaces | Notes |
|---|---|---|
| `logo.svg`, `logo.webp` or `logo.png` | The mark above the name on the home and vault pages | Shown in a square of up to 80 px. It does not have to be square itself; it is fitted, not stretched. Used in both themes unless you add the next file. |
| `logo-light.svg`, `logo-light.webp` or `logo-light.png` | The same mark in the light theme | Optional. Add it when your logo is made for dark backgrounds. |
| `favicon.svg` | The tab icon in current browsers | Supply this together with `favicon.ico`. |
| `favicon.ico` | The tab icon in Safari and older browsers | 16, 32 and 48 px in one file. |
| `apple-touch-icon.png` | The icon of a home-screen shortcut on iOS | 180 × 180 px, no transparency. |
| `icon-192.png` | The icon in the web app manifest | 192 × 192 px. |
| `icon-512.png` | The large icon in the web app manifest | 512 × 512 px. |
| `icon-maskable-512.png` | The icon Android crops to its own shape | 512 × 512 px, no transparency. Keep the artwork inside the central circle that is 80% of the width. |

The rules the server applies:

- **Names are exact and case-sensitive.** `Logo.SVG` is not `logo.svg`.
- **One megabyte per file** at most (1024 KiB).
- If several logo formats are present, the first of `svg`, `webp`, `png` is used.
- Files are read once, at startup. Restart after adding or changing one.
- Anything else in the directory is ignored and is never served.

The server log shows what was picked up. A line `Serving the operator's branding files` lists the URLs in use, and every file that was skipped has a warning of its own with the reason.

## What does not change

- The **Source link** in the footer stays. See [ATTRIBUTION.md](../ATTRIBUTION.md).
- The **terms of service** are a separate file, [TOS.md](../TOS.md), and mention the project name. Edit it to match your instance.
- Fonts, layout and all other texts.

## How it works

The published image is used as it is. At startup the server validates the settings and writes them into the page it keeps in memory. Images from the branding directory are read into memory at the same moment and answered from there.

What this means for the security of an instance:

- **Nothing is loaded from elsewhere.** No setting accepts a URL. Your logo and icons are served by your own instance, and the Content-Security-Policy still refuses images and fonts from any other origin. An SVG is no exception: on the page it is shown as a static picture, and opened on its own it is served under the same policy as every other response, so a script written into it does not run.
- **No security header changes** with branding, and no branding setting can switch a protection off.
- **Only the listed file names are ever read** from the branding directory. A request cannot reach any other file in it.
- **There is no service worker.** The web app manifest lets a visitor add the site to a home screen with the right name and icon, and nothing more. The application code is fetched from your server on every visit, so a fix you deploy reaches everyone at once.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The server does not start and logs `BRAND_… must be …` | A setting failed its check | Correct the value named in the message |
| `.env` was changed but the page looks the same | The container was restarted, not recreated | `docker compose up -d` |
| A new logo or icon does not appear | Wrong file name, a file over the size limit, or no restart | Check the name against the table, read the warnings in the log, restart |
| The tab still shows the old favicon | Browsers cache favicons apart from the page | Close and reopen the tab, or clear the site data |
| Nothing from this page has any effect | A reverse proxy serves `frontend/dist` from disk | Proxy every request to the app, as [HARDENING.md](HARDENING.md#version-disclosure) requires |
| The Vite dev server shows the built-in branding | Branding is applied by the backend to the built page | Run `npm run build` in `frontend/` and open the backend port instead |
