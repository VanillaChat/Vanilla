import { execFile } from 'node:child_process';
import path from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import devtools from 'solid-devtools/vite';
import { defineConfig, loadEnv } from 'vite';
import solid from 'vite-plugin-solid';

/** Rebuilds the WASM codec on dev start and whenever the voice crate changes. */
function voiceWasm() {
	const root = path.resolve(import.meta.dirname, '../../crates/voice');
	const build = () =>
		new Promise((resolve) => {
			execFile(path.join(root, 'build-wasm.sh'), (err, _out, stderr) => {
				if (err) console.warn(`[voice] wasm build failed:\n${stderr || err.message}`);
				else console.log('[voice] wasm rebuilt');
				resolve(!err);
			});
		});
	return {
		name: 'voice-wasm',
		apply: 'serve',
		async configureServer(server) {
			await build();
			server.watcher.add(path.join(root, 'src'));
			let pending = null;
			server.watcher.on('change', (file) => {
				if (!file.startsWith(path.join(root, 'src')) || !file.endsWith('.rs')) return;
				clearTimeout(pending);
				pending = setTimeout(async () => {
					if (await build()) server.ws.send({ type: 'full-reload' });
				}, 200);
			});
		},
	};
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	const apiTarget = env.API_TARGET ?? 'http://localhost:3000';
	const gatewayTarget = env.GATEWAY_TARGET ?? 'ws://localhost:3000';

	return {
		plugins: [voiceWasm(), devtools(), tanstackRouter({ target: 'solid' }), solid()],
		server: {
			allowedHosts: env.ALLOWED_HOSTS?.split(',')
				.map((h) => h.trim())
				.filter(Boolean),
			proxy: {
				'/auth': { target: apiTarget, changeOrigin: true },
				'/guilds': { target: apiTarget, changeOrigin: true },
				'/channels': { target: apiTarget, changeOrigin: true },
				'/users': { target: apiTarget, changeOrigin: true },
				'/invites': { target: apiTarget, changeOrigin: true },
				'^/i/': { target: apiTarget, changeOrigin: true, xfwd: true },
				'/admin': { target: apiTarget, changeOrigin: true },
				'/cdn': { target: apiTarget, changeOrigin: true },
				'/unfurl': { target: apiTarget, changeOrigin: true },
				'/dms': { target: apiTarget, changeOrigin: true },
				'/friends': { target: apiTarget, changeOrigin: true },
				'/search': { target: apiTarget, changeOrigin: true },
				'/attachments': { target: apiTarget, changeOrigin: true },
				'/gateway': { target: gatewayTarget, ws: true, changeOrigin: true },
				'/voice': { target: gatewayTarget, ws: true, changeOrigin: true },
			},
		},
		// Workers and worklets are ES modules (they import the WASM glue and shared code).
		worker: { format: 'es' },
		define: {
			'process.env.API_URL': JSON.stringify(env.API_URL ?? ''),
			'process.env.GATEWAY_URL': JSON.stringify(env.GATEWAY_URL ?? '/gateway'),
		},
	};
});
