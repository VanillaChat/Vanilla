import { createFileRoute } from '@tanstack/solid-router';
import { onMount } from 'solid-js';
import { getSession } from '../api/auth';

export const Route = createFileRoute('/invite/$code')({
	component: InviteLanding,
});

function InviteLanding() {
	const params = Route.useParams();
	onMount(async () => {
		const code = encodeURIComponent(params().code);
		const session = await getSession().catch(() => null);
		window.location.replace(session ? `/app?invite=${code}` : `/register?invite=${code}`);
	});
	return null;
}
