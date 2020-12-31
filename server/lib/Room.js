const EventEmitter = require('events').EventEmitter;
const protoo = require('protoo-server');
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const config = require('../config');
const Bot = require('./Bot');

const logger = new Logger('Room');

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorker, roomId, socket })
	{
		logger.info('create() [roomId:%s]', roomId);

		// Create a protoo Room instance.
		// const protooRoom = new protoo.Room();

		// Router media codecs.
		const { mediaCodecs } = config.mediasoup.routerOptions;

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		const bot = await Bot.create({ mediasoupRouter });

		return new Room(
			{
				roomId,
				socket,
				mediasoupRouter,
				audioLevelObserver,
				bot
			});
	}

	constructor({ 
		roomId, 
		socket, 
		mediasoupRouter, 
		audioLevelObserver, 
		bot
	})
	{
		super();
		this.setMaxListeners(Infinity);

		this.socket = socket;

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// peers = new Map();

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// protoo Room instance.
		// @type {protoo.Room}
		// this._protooRoom = protooRoom;

		// Map of broadcasters indexed by id. Each Object has:
		// - {String} id
		// - {Object} data
		//   - {String} displayName
		//   - {Object} device
		//   - {RTCRtpCapabilities} rtpCapabilities
		//   - {Map<String, mediasoup.Transport>} transports
		//   - {Map<String, mediasoup.Producer>} producers
		//   - {Map<String, mediasoup.Consumers>} consumers
		//   - {Map<String, mediasoup.DataProducer>} dataProducers
		//   - {Map<String, mediasoup.DataConsumers>} dataConsumers
		// @type {Map<String, Object>}
		this._broadcasters = new Map();

		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
		this._audioLevelObserver = audioLevelObserver;

		// DataChannel bot.
		// @type {Bot}
		this._bot = bot;

		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

		// Handle audioLevelObserver.
		this._handleAudioLevelObserver();

		// For debugging.
		global.audioLevelObserver = this._audioLevelObserver;
		global.bot = this._bot;

		// this._handleEvents();

		this.videoProducers = {};
		this.audioProducers = {};
		
		this.peers = new Map();

		this.transports = new Map();

	}
	
	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Close the protoo Room.
		// this._protooRoom.close();

		// Close the mediasoup Router.
		this._mediasoupRouter.close();

		// Close the Bot.
		this._bot.close();

		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			throttle.stop({})
				.catch(() => {});
		}
	}
	sendResponse(response, callback) 
	{
		callback(null, response);
	}

	// --- send error to client ---
	sendReject(error, callback)
	{
		callback(error.toString(), null);
	}
	logStatus()
	{
		logger.info(
			'logStatus() [roomId:%s, protoo Peers:%s, mediasoup Transports:%s]',
			this._roomId,
			this.peers.size,
			this._mediasoupRouter._transports.size); // NOTE: Private API.
	}

	/**
	 * Called from server.js upon a protoo WebSocket connection request from a
	 * browser.
	 *
	 * @param {String} peerId - The id of the protoo peer to be created.
	 * @param {Boolean} consume - Whether this peer wants to consume from others.
	 * @param {protoo.WebSocketTransport} protooWebSocketTransport - The associated
	 *   protoo WebSocket transport.
	 */
	handleProtooConnection({ peerId, consume, socket })
	{
		const existingPeer = this.peers.get(peerId);

		if (existingPeer)
		{
			logger.warn(
				'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
				peerId);

			existingPeer.close();
		}

		// Create a new protoo Peer with the given peerId.
		try
		{
			this.peers.set(peerId, socket);
		}
		catch (error)
		{
			logger.error('protooRoom.createPeer() failed:%o', error);
		}
		const peer = this.peers.get(peerId);

		// Use the peer.data object to store mediasoup related objects.
		peer.data={};
		peer.data.id = peerId;

		// Not joined after a custom protoo 'join' request is later received.
		peer.data.consume = consume;
		peer.data.joined = false;
		peer.data.displayName = undefined;
		peer.data.device = undefined;
		peer.data.rtpCapabilities = undefined;
		peer.data.sctpCapabilities = undefined;

		// Have mediasoup related maps ready even before the Peer joins since we
		// allow creating Transports before joining.
		peer.data.transports = new Map();
		peer.data.producers = new Map();
		peer.data.consumers = new Map();
		peer.data.dataProducers = new Map();
		peer.data.dataConsumers = new Map();

		peer.on('disconnect', () =>
		{

			if (this._closed)
				return;
			logger.debug('protoo Peer "close" event [peerId:%s]');

			// If the Peer was joined, notify all Peers.
			if (peer.data.joined)
			{
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.emit('peerClosed', { peerId: peer.id });
					// .catch(() => {});
				}
			}

			// Iterate and close all mediasoup Transport associated to this Peer, so all
			// its Producers and Consumers will also be closed.
			for (const transport of peer.data.transports.values())
			{
				transport.close();
			}
			this.peers.delete(peer.data.id);
			// this.close();
			// If this is the latest Peer in the room, close the room.
			// if (peers.length === 0)
			// {
			// 	logger.info(
			// 		'last Peer in the room left, closing the room [roomId:%s]',
			// 		this._roomId);

			// 	this.close();
			// }
		});

		peer.on('createWebRtcTransport', async (data, callback) => 
		{
			// NOTE: Don't require that the Peer is joined here, so the client can
			// initiate mediasoup Transports and be ready when he later joins.

			const {
				forceTcp,
				producing,
				consuming,
				sctpCapabilities
			} = data;

			const webRtcTransportOptions =
				{
					...config.mediasoup.webRtcTransportOptions,
					enableSctp     : Boolean(sctpCapabilities),
					numSctpStreams : (sctpCapabilities || {}).numStreams,
					appData        : { producing, consuming }
				};

			if (forceTcp)
			{
				webRtcTransportOptions.enableUdp = false;
				webRtcTransportOptions.enableTcp = true;
			}

			const transport = await this._mediasoupRouter.createWebRtcTransport(
				webRtcTransportOptions);

			transport.on('sctpstatechange', (sctpState) =>
			{
				logger.debug('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState);
			});

			transport.on('dtlsstatechange', (dtlsState) =>
			{
				if (dtlsState === 'failed' || dtlsState === 'closed')
					logger.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
			});

			// NOTE: For testing.
			// await transport.enableTraceEvent([ 'probation', 'bwe' ]);
			await transport.enableTraceEvent([ 'bwe' ]);

			transport.on('trace', (trace) =>
			{
				logger.debug(
					'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
					transport.id, trace.type, trace);
				// ???????
				if (trace.type === 'bwe' && trace.direction === 'out')
				{
					peer.emit(
						'downlinkBwe',
						{
							desiredBitrate          : trace.info.desiredBitrate,
							effectiveDesiredBitrate : trace.info.effectiveDesiredBitrate,
							availableBitrate        : trace.info.availableBitrate
						});
					// .catch(() => {});
				}
			});

			// Store the WebRtcTransport into the protoo Peer data Object.
			peer.data.transports.set(transport.id, transport);

			const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;

			// If set, apply max incoming bitrate limit.
			if (maxIncomingBitrate)
			{
				try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
				catch (error) {}
			}
			this.sendResponse(
				{
					id             : transport.id,
					iceParameters  : transport.iceParameters,
					iceCandidates  : transport.iceCandidates,
					dtlsParameters : transport.dtlsParameters,
					sctpParameters : transport.sctpParameters
				},
				callback
			);
		});
		peer.on('connectWebRtcTransport', async (data, callback) => 
		{
			const { transportId, dtlsParameters } = data;
			const transport = peer.data.transports.get(transportId);

			if (!transport)
				throw new Error(`transport with id "${transportId}" not found`);
			await transport.connect({ dtlsParameters });
			this.sendResponse(
				'accept',
				callback
			);
		});
		peer.on('produce', async (data, callback) => 
		{
			// Ensure the Peer is joined.
			if (!peer.data.joined)
				throw new Error('Peer not yet joined');

			const { transportId, kind, rtpParameters } = data;
			let { appData } = data;
			const transport = peer.data.transports.get(transportId);

			if (!transport)
				throw new Error(`transport with id "${transportId}" not found`);

			// Add peerId into appData to later get the associated Peer during
			// the 'loudest' event of the audioLevelObserver.
			appData = { ...appData, peerId: peer.id };

			const producer = await transport.produce(
				{
					kind,
					rtpParameters,
					appData
				// keyFrameRequestDelay: 5000
				});

			// Store the Producer into the protoo Peer data Object.
			peer.data.producers.set(producer.id, producer);

			// Set Producer events.
			producer.on('score', (score) =>
			{
			// logger.debug(
			// 	'producer "score" event [producerId:%s, score:%o]',
			// 	producer.id, score);

				peer.emit('producerScore', { producerId: producer.id, score });
				// .catch(() => {});
			});

			producer.on('videoorientationchange', (videoOrientation) =>
			{
				logger.debug(
					'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
					producer.id, videoOrientation);
			});

			// NOTE: For testing.
			// await producer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
			// await producer.enableTraceEvent([ 'pli', 'fir' ]);
			// await producer.enableTraceEvent([ 'keyframe' ]);

			producer.on('trace', (trace) =>
			{
				logger.debug(
					'producer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
					producer.id, trace.type, trace);
			});

			this.sendResponse({ id: producer.id }, callback);

			// Optimization: Create a server-side Consumer for each Peer.
			for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
			{
				this._createConsumer(
					{
						consumerPeer : otherPeer,
						producerPeer : peer,
						producer
					});
			}

			// Add into the audioLevelObserver.
			if (producer.kind === 'audio')
			{
				this._audioLevelObserver.addProducer({ producerId: producer.id })
					.catch(() => {});
			}

		});
		peer.on('produceData', async (data, callback) => 
		{
			// Ensure the Peer is joined.
			if (!peer.data.joined)
				throw new Error('Peer not yet joined');

			const {
				transportId,
				sctpStreamParameters,
				label,
				protocol,
				appData
			} = data;

			const transport = peer.data.transports.get(transportId);

			if (!transport)
				throw new Error(`transport with id "${transportId}" not found`);

			const dataProducer = await transport.produceData(
				{
					sctpStreamParameters,
					label,
					protocol,
					appData
				});

			// Store the Producer into the protoo Peer data Object.
			peer.data.dataProducers.set(dataProducer.id, dataProducer);

			this.sendResponse({ id: dataProducer.id }, callback);

			switch (dataProducer.label)
			{
				case 'chat':
				{
					// Create a server-side DataConsumer for each Peer.
					for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
					{
						this._createDataConsumer(
							{
								dataConsumerPeer : otherPeer,
								dataProducerPeer : peer,
								dataProducer
							});
					}

					break;
				}

				case 'bot':
				{
					// Pass it to the bot.
					this._bot.handlePeerDataProducer(
						{
							dataProducerId : dataProducer.id,
							peer
						});

					break;
				}
			}
		});
		peer.on('join', async (data, callback) => 
		{
			// Ensure the Peer is not already joined.
			if (peer.data.joined)
				throw new Error('Peer already joined');
		
			const {
				displayName,
				device,
				rtpCapabilities,
				sctpCapabilities
			} = data;
		
			// Store client data into the protoo Peer data object.
			peer.data.joined = true;
			peer.data.displayName = displayName;
			peer.data.device = device;
			peer.data.rtpCapabilities = rtpCapabilities;
			peer.data.sctpCapabilities = sctpCapabilities;
			
			// Tell the new Peer about already joined Peers.
			// And also create Consumers for existing Producers.
			const joinedPeers =
						[
							...this._getJoinedPeers(),
							...this._broadcasters.values()
						];
			
			// // Reply now the request with the list of joined peers (all but the new one).
			const peerInfos = joinedPeers
				.filter((joinedPeer) => joinedPeer.id !== peer.id)
				.map((joinedPeer) => ({
					id          : joinedPeer.id,
					displayName : joinedPeer.data.displayName,
					device      : joinedPeer.data.device
				}));
			
			// // ?????????
			// // accept({ peers: peerInfos });
			this.sendResponse(
				peerInfos,
				callback
			);
			// // Mark the new Peer as joined.
			peer.data.joined = true;	
		
			for (const joinedPeer of joinedPeers)
			{
				// Create Consumers for existing Producers.
				for (const producer of joinedPeer.data.producers.values())
				{
					this._createConsumer(
						{
							consumerPeer : peer,
							producerPeer : joinedPeer,
							producer
						});
				}
		
				// Create DataConsumers for existing DataProducers.
				for (const dataProducer of joinedPeer.data.dataProducers.values())
				{
					if (dataProducer.label === 'bot')
						continue;
		
					this._createDataConsumer(
						{
							dataConsumerPeer : peer,
							dataProducerPeer : joinedPeer,
							dataProducer
						});
				}
			}
			// Create DataConsumers for bot DataProducer.
			this._createDataConsumer(
				{
					dataConsumerPeer : peer,
					dataProducerPeer : null,
					dataProducer     : this._bot.dataProducer
				});
		
			// Notify the new Peer to all other Peers.
			for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
			{
				otherPeer.emit(
					'newPeer',
					{
						id          : peer.id,
						displayName : peer.data.displayName,
						device      : peer.data.device
					});
				// .catch(() => {});
			}
		});
		peer.on('getRouterRtpCapabilities', (data, callback) => 
		{
			this.sendResponse(this._mediasoupRouter.rtpCapabilities, callback);
			// if (router) {
			//   //console.log('getRouterRtpCapabilities: ', router.rtpCapabilities);
			//   sendResponse(router.rtpCapabilities, callback);
			// }
			// else {
			//   sendReject({ text: 'ERROR- router NOT READY' }, callback);
			// }
		});
	}

	getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	_handleAudioLevelObserver()
	{
		this._audioLevelObserver.on('volumes', (volumes) =>
		{
			const { producer, volume } = volumes[0];

			// logger.debug(
			// 	'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
			// 	producer.id, volume);

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.emit(
					'activeSpeaker',
					{
						peerId : producer.appData.peerId,
						volume : volume
					});
				// .catch(() => {});
			}
		});

		this._audioLevelObserver.on('silence', () =>
		{
			// logger.debug('audioLevelObserver "silence" event');

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.emit('activeSpeaker', { peerId: null });
				// .catch(() => {});
			}
		});
	}

	/**
	 * Helper to get the list of joined protoo peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		// return this.peers
		// 	.filter((peer) => peer.data.joined && peer !== excludePeer);
		// [ ...this.peers.values() ].map((peer,index)=>{
		// 	console.log(peer.data,"XXXX")
		// })
		return [ ...this.peers.values() ]
			.filter((peer) => peer.data.joined && peer !== excludePeer);
	}
	async _createConsumer({ consumerPeer, producerPeer, producer })
	{
		// Optimization:
		// - Create the server-side Consumer in paused mode.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).
		// - If audio (or video), it will avoid that RTP packets are received by the
		//   remote endpoint *before* the Consumer is locally created in the endpoint
		//   (and before the local SDP O/A procedure ends). If that happens (RTP
		//   packets are received before the SDP O/A is done) the PeerConnection may
		//   fail to associate the RTP stream.

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		if (
			!consumerPeer.data.rtpCapabilities ||
			!this._mediasoupRouter.canConsume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities
				})
		)
		{
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(consumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createConsumer() | Transport for consuming not found');

			return;
		}

		// Create the Consumer in paused mode.
		let consumer;

		try
		{
			consumer = await transport.consume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities,
					paused          : true
				});
		}
		catch (error)
		{
			logger.warn('_createConsumer() | transport.consume():%o', error);

			return;
		}

		// Store the Consumer into the protoo consumerPeer data Object.
		consumerPeer.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			consumerPeer.data.consumers.delete(consumer.id);

			consumerPeer.emit('consumerClosed', { consumerId: consumer.id });
			// .catch(() => {});
		});

		consumer.on('producerpause', () =>
		{
			consumerPeer.emit('consumerPaused', { consumerId: consumer.id });
			// .catch(() => {});
		});

		consumer.on('producerresume', () =>
		{
			consumerPeer.emit('consumerResumed', { consumerId: consumer.id });
			// .catch(() => {});
		});

		consumer.on('score', (score) =>
		{
			// logger.debug(
			// 	'consumer "score" event [consumerId:%s, score:%o]',
			// 	consumer.id, score);

			consumerPeer.emit('consumerScore', { consumerId: consumer.id, score });
			// .catch(() => {});
		});

		consumer.on('layerschange', (layers) =>
		{
			consumerPeer.emit(
				'consumerLayersChanged',
				{
					consumerId    : consumer.id,
					spatialLayer  : layers ? layers.spatialLayer : null,
					temporalLayer : layers ? layers.temporalLayer : null
				});
			// .catch(() => {});
		});

		// NOTE: For testing.
		// await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
		// await consumer.enableTraceEvent([ 'pli', 'fir' ]);
		// await consumer.enableTraceEvent([ 'keyframe' ]);

		consumer.on('trace', (trace) =>
		{
			logger.debug(
				'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
				consumer.id, trace.type, trace);
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			consumerPeer.emit(
				'newConsumer',
				{
					peerId         : producerPeer.id,
					producerId     : producer.id,
					id             : consumer.id,
					kind           : consumer.kind,
					rtpParameters  : consumer.rtpParameters,
					type           : consumer.type,
					appData        : producer.appData,
					producerPaused : consumer.producerPaused
				});

			// Now that we got the positive response from the remote endpoint, resume
			// the Consumer so the remote endpoint will receive the a first RTP packet
			// of this new stream once its PeerConnection is already ready to process
			// and associate it.
			await consumer.resume();

			consumerPeer.emit(
				'consumerScore',
				{
					consumerId : consumer.id,
					score      : consumer.score
				});
			
			return;
			// .catch(() => {});
		}
		catch (error)
		{
			logger.warn('_createConsumer() | failed:%o', error);
		}
	}
	async _createDataConsumer(
		{
			dataConsumerPeer,
			dataProducerPeer = null, // This is null for the bot DataProducer.
			dataProducer
		})
	{
		// NOTE: Don't create the DataConsumer if the remote Peer cannot consume it.
		if (!dataConsumerPeer.data.sctpCapabilities)
			return;

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(dataConsumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createDataConsumer() | Transport for consuming not found');

			return;
		}

		// Create the DataConsumer.
		let dataConsumer;

		try
		{
			dataConsumer = await transport.consumeData(
				{
					dataProducerId : dataProducer.id
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | transport.consumeData():%o', error);

			return;
		}

		// Store the DataConsumer into the protoo dataConsumerPeer data Object.
		dataConsumerPeer.data.dataConsumers.set(dataConsumer.id, dataConsumer);

		// Set DataConsumer events.
		dataConsumer.on('transportclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);
		});

		dataConsumer.on('dataproducerclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);

			dataConsumerPeer.emit(
				'dataConsumerClosed', { dataConsumerId: dataConsumer.id });
			// .catch(() => {});
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			dataConsumerPeer.emit(
				'newDataConsumer',
				{
					// This is null for bot DataProducer.
					peerId               : dataProducerPeer ? dataProducerPeer.id : null,
					dataProducerId       : dataProducer.id,
					id                   : dataConsumer.id,
					sctpStreamParameters : dataConsumer.sctpStreamParameters,
					label                : dataConsumer.label,
					protocol             : dataConsumer.protocol,
					appData              : dataProducer.appData
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | failed:%o', error);
		}
	}
}

module.exports = Room;
