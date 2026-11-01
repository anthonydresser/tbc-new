// Electron main process: spawn the wowsimtbc server binary and open its UI in a
// desktop window. The Go process does ALL the work (embedded UI + native sims);
// this shell is purely the chrome around it.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

let serverProcess = null;

// Path to the Go binary: packaged builds read it from the installer resources,
// the dev checkout reads the standalone binary built by `make wowsimtbc`.
const serverBinary = () => {
	const exe = process.platform === 'win32' ? 'wowsimtbc.exe' : 'wowsimtbc';
	return app.isPackaged
		? path.join(process.resourcesPath, 'bin', exe)
		: path.join(__dirname, '..', `wowsimtbc-standalone${process.platform === 'win32' ? '.exe' : ''}`);
};

// Ask the OS for a free port so a dev server on :3333 (or a second app instance)
// never collides with ours.
const freePort = () =>
	new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});

const waitForServer = (baseUrl, timeoutMs = 30000) =>
	new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = async () => {
			if (serverProcess?.exitCode !== null && serverProcess !== null) {
				reject(new Error(`server exited early with code ${serverProcess.exitCode}`));
				return;
			}
			try {
				// The root redirects to /tbc/ — any HTTP response means the server is up.
				const res = await fetch(baseUrl, { redirect: 'manual' });
				if (res.status > 0) {
					resolve();
					return;
				}
			} catch {
				// connection refused: not up yet
			}
			if (Date.now() > deadline) {
				reject(new Error('timed out waiting for wowsimtbc server'));
				return;
			}
			setTimeout(attempt, 150);
		};
		attempt();
	});

app.whenReady().then(async () => {
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}/`;

	serverProcess = spawn(serverBinary(), ['--host', `127.0.0.1:${port}`, '--launch=false', '--nvc'], {
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	serverProcess.on('error', err => {
		console.error('failed to launch wowsimtbc server:', err);
		app.quit();
	});

	const win = new BrowserWindow({
		width: 1600,
		height: 1000,
		autoHideMenuBar: true,
		title: 'WoWSims TBC',
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		// External links (discord, github, guides) open in the real browser.
		if (url.startsWith('http://127.0.0.1') || url.startsWith(baseUrl)) return { action: 'allow' };
		require('electron').shell.openExternal(url);
		return { action: 'deny' };
	});

	win.loadURL('about:blank');
	win.webContents.insertText(''); // no-op, keeps the blank window from idling white
	await waitForServer(baseUrl);
	win.loadURL(baseUrl);
});

// The Go server is our child; never leave it running past the app.
app.on('will-quit', () => serverProcess?.kill());
app.on('window-all-closed', () => app.quit());
