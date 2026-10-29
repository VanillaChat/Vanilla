declare const process: {
	env: {
		API_URL: string;
		GATEWAY_URL: string;
	};
};

declare module '*.ftl?raw' {
	const content: string;
	export default content;
}

declare module '*?worker&url' {
	const url: string;
	export default url;
}

declare module '*.wasm?url' {
	const url: string;
	export default url;
}

declare module '*?worker' {
	const WorkerConstructor: new (options?: { name?: string }) => Worker;
	export default WorkerConstructor;
}

declare module '*.js?url' {
	const url: string;
	export default url;
}
