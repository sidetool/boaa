import type { BuiltInExternalSourceDefinition } from '../app-external-source-registry';
import type { RemoteFileConnectionStatus } from '../../../packages/extension-contracts/remote-files';
export const remoteFileSourceId = (id: string) => `boaa.external.remote-file.${id}` as const;
export function remoteFileBuiltInSource(connection: RemoteFileConnectionStatus): BuiltInExternalSourceDefinition {
  return {
    brokerId: remoteFileSourceId(connection.id!),
    descriptor: {
      id: remoteFileSourceId(connection.id!),
      schemaVersion: 1,
      title: connection.name!,
      description: `${connection.protocol === 'sftp' ? 'SFTP' : 'WebDAV'} · ${connection.username} · ${connection.endpoint}`,
      kind: 'cloud_file',
      capabilities: ['browse', 'search', 'file-download'],
      runtimes: ['self-host-gateway'],
      order: 40,
    },
  };
}
