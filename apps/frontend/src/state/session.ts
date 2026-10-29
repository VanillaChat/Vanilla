import { createResource, type Resource } from 'solid-js';
import { getSession, type Session } from '../api/auth';

const fetcher = async (): Promise<Session | null> => {
	try {
		return await getSession();
	} catch {
		return null;
	}
};

const [resource, { refetch }] = createResource<Session | null>(fetcher);

export const session: Resource<Session | null> = resource;
export const refetchSession = refetch;
