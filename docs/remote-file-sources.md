# WebDAV and SFTP file sources

Hosted BOAA provides WebDAV and SFTP under Settings → Sources → Built-in sources. Use **Add** below Built-in sources, choose a protocol and give the server a name. Each administrator account can save up to 16 independently named connections, including multiple servers using the same protocol. Connections are scoped to that account and encrypted in the server credential vault, so another device using the same account can reuse them. Disconnecting removes the saved connection for all of that account's devices, without deleting imported books or modifying the remote server.

Both connectors list folders and import TXT, Markdown, EPUB, PDF and supported comic archives through the existing file-import flow. Search filters names in the current folder. Remote files are read-only: BOAA does not upload, rename or delete them. Downloads are streamed through the authenticated BOAA API, with a 512 MiB cap, cancellation and connection-generation checks. Directory enumeration is bounded to 5,000 entries and responses are paginated in groups of 200. Choose a narrower starting folder for larger directories.

## WebDAV

Enter the exact WebDAV folder URL, username and password (or the provider's app password). HTTPS and ordinary certificate verification are the default. Plain HTTP requires explicit selection in the connection form. Basic authentication is supported. Redirects are refused to keep credentials on the configured origin; use the final folder URL. PROPFIND uses Depth: 1. XML entities, out-of-root responses and cross-origin paths are rejected.

## SFTP

Enter `sftp://host:port` (port 22 by default), username, starting folder and either password or an OpenSSH private key. Encrypted private keys also accept a passphrase. Paste key contents rather than a path on the BOAA server.

The initial connection uses trust-on-first-use and stores the SHA-256 host-key fingerprint. To authenticate the server on the first connection, enter a fingerprint obtained independently from its administrator. Subsequent connections require the stored key; changing credentials does not bypass that check. A legitimate server-key change requires disconnecting and registering again. Symbolic links are excluded from listings and resolved paths must stay within the starting folder. No shell or remote command is executed.

## Deployment and boundaries

Both protocols run on the BOAA server, including when the UI is on a phone or desktop client. The Add control is available to administrators connected to a BOAA server. A standalone local client without a server does not offer it. Existing administrator-only external-server policy applies; members cannot connect the server to arbitrary storage hosts. NAS and private LAN addresses are supported. Requests go directly to the configured storage server, not through the content-source proxy. No site-specific address or credential is included in the application.

Implementation checks use a local WebDAV endpoint and an actual SSH2/SFTP session. Verification against a particular NAS still requires that server's address and credentials.
