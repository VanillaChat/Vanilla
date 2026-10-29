import { createRouter, RouterProvider } from '@tanstack/solid-router';
import { render } from 'solid-js/web';
import { routeTree } from './routeTree.gen';
import { isDesktop } from './state/presence';
import './styles.css';
import '@fortawesome/fontawesome-free/css/all.min.css';

const router = createRouter({
	routeTree,
	defaultStaleTime: 5000,
	scrollRestoration: true,
});

declare module '@tanstack/solid-router' {
	interface Register {
		router: typeof router;
	}
}

if (isDesktop()) {
	document.documentElement.style.setProperty('--titlebar', '2.25rem');
	window.addEventListener('keydown', (e) => {
		const reload = ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') || e.key === 'F5';
		if (!reload) return;
		e.preventDefault();
		window.location.reload();
	});
} else import('solid-devtools');

const rootElement = document.getElementById('app');

if (!rootElement) {
	throw new Error('Root element #app not found');
}

if (!rootElement.innerHTML) {
	render(() => <RouterProvider router={router} />, rootElement);
}

// The desktop windows start hidden; show this one once the first render is in. Not
// requestAnimationFrame: a hidden webview never runs it.
if (isDesktop()) {
	setTimeout(() => {
		(
			window as unknown as {
				__TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
			}
		).__TAURI_INTERNALS__
			.invoke('reveal')
			.catch(() => {});
	}, 60);
}
