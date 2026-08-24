import { basename, dirname, resolve } from "node:path";

export const FORK_SERVER_DIRECTORY_PREFIX = "prime-agent-forkserver-";
export const FORK_SERVER_CONTROL_SOCKET_NAME = "control.sock";

const MKDTEMP_SUFFIX_LENGTH = 6;

/** Match the reserved Linux socket namespace created by ForkServer.start(). */
export function isForkServerControlSocketPath(
	socketPath: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "linux" || basename(socketPath) !== FORK_SERVER_CONTROL_SOCKET_NAME) {
		return false;
	}
	const directoryName = basename(dirname(resolve(socketPath)));
	return (
		directoryName.startsWith(FORK_SERVER_DIRECTORY_PREFIX) &&
		directoryName.length === FORK_SERVER_DIRECTORY_PREFIX.length + MKDTEMP_SUFFIX_LENGTH
	);
}
