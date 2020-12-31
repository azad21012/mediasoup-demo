let PORT = 4443;
const IP = '192.168.1.2';

if (window.location.hostname === 'test.mediasoup.org')
	PORT = 4444;

export function getSocketUrl()
{
	const hostname = IP || window.location.hostname;

	return `https://${hostname}:${PORT}`;
}
