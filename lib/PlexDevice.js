'use strict';

const Homey = require('homey');

const PlexAPI = require('./PlexAPI');
const PlexUtil = require('./PlexUtil');

module.exports = class PlexDevice extends Homey.Device {

  static POLL_INTERVAL = 1000 * 60; // Every minute

  async onInit() {
    this.pollInterval = this.homey.setInterval(() => this.poll(), this.constructor.POLL_INTERVAL);
    this.poll();

    if (this.hasCapability('speaker_track')) {
      this.removeCapability('speaker_track').catch(this.error);
    }

    if (this.hasCapability('speaker_album')) {
      this.removeCapability('speaker_album').catch(this.error);
    }

    if (this.hasCapability('speaker_artist')) {
      this.removeCapability('speaker_artist').catch(this.error);
    }

    // this.sessionImage = null;
    // this.image = await this.homey.images.createImage();
    // this.image.setUrl(null);
    // await this.setAlbumArtImage(this.image);

    this.sessionStates = {
      // [sessionKey]: { state }
    };
  }

  async onInitPlexAPI() {
    const { machineIdentifier } = this.getData();
    const { token } = this.getStore();

    this.api = new PlexAPI({
      homey: this.homey,
      token,
      machineIdentifier,
    });

    await this.api.connect()
      .then(() => {
        this.api.on('message', message => {
          this.onMessage(message).catch(this.error);
        });
      })
      .catch(err => {
        delete this.api;
        throw err;
      });
  }

  async onDeleted() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  async onMessage(message) {
    this.log('onMessage', message);

    switch (message.type) {
      case 'playing':
        await this.onMessagePlaying(message['PlaySessionStateNotification'][0]);
        break;
      default:
        break;
    }
  }

  async onMessagePlaying({ sessionKey, key, state }) {
    if (state === 'buffering') return;
    if (this.sessionStates[sessionKey] === state) return;
    this.sessionStates[sessionKey] = state;

    const session = await this.api.getSessionCached({ sessionKey });

    switch (state) {
      case 'playing': {

        const mediaImage = await this.homey.images.createImage();
        try {
          const url = await this.api.url;
          const thumb = PlexUtil.getThumb(session);
          mediaImage.setUrl(`${url}${thumb}?X-Plex-Token=${this.api.token}`);
        } catch (err) {
          this.error(`Error Creating Media Image: ${err.message}`);
        } finally {
          // Clear the image after 5 minutes
          this.homey.setTimeout(() => {
            mediaImage.unregister().catch(this.error);
          }, 1000 * 60 * 5);
        }

        await this.homey.flow.getDeviceTriggerCard('player_start')
          .trigger(this, {
            playerTitle: session['Player']['title'],
            playerId: session['Player']['machineIdentifier'],
            mediaTitle: PlexUtil.getTitle(session),
            mediaImage,
            userTitle: session['User']['title'],
          });
        break;
      }
      case 'paused': {
        await this.homey.flow.getDeviceTriggerCard('player_pause')
          .trigger(this, {
            playerTitle: session['Player']['title'],
            playerId: session['Player']['machineIdentifier'],
            mediaTitle: PlexUtil.getTitle(session),
            userTitle: session['User']['title'],
          });
        break;
      }
      case 'stopped': {
        await this.homey.flow.getDeviceTriggerCard('player_stop')
          .trigger(this, {
            playerTitle: session['Player']['title'],
            playerId: session['Player']['machineIdentifier'],
            mediaTitle: PlexUtil.getTitle(session),
            userTitle: session['User']['title'],
          });
        break;
      }
      default:
        break;
    }
  }

  poll() {
    if (!this.api) {
      this.log('Trying to connect...');
      this.onInitPlexAPI()
        .then(() => {
          this.setAvailable().catch(this.error);
        })
        .catch(err => {
          this.error(`Error Connecting: ${err.message}`);
          this.setUnavailable(err).catch(this.error);
        });
    }
    // Get Sessions
    // this.api.getSessions()
    //   .then(sessions => {
    //     const [session] = sessions;

    //     if (session) {
    //       // Set Capabilities
    //       this.setCapabilityValue('speaker_track', session.title || null).catch(this.error);
    //       this.setCapabilityValue('speaker_artist', session.grandparentTitle || null).catch(this.error);
    //       this.setCapabilityValue('speaker_album', session.parentTitle || null).catch(this.error);

    //       const thumb = PlexUtil.getThumb(session);

    //       // Set Image
    //       if (this.sessionImage !== thumb) {
    //         // Create the Image URL
    //         Promise.resolve().then(async () => {
    //           const url = await this.api.url;
    //           this.sessionImage = `${url}${thumb}?X-Plex-Token=${this.api.token}`;

    //           // Register the Image
    //           if (this.sessionImage.startsWith('https:')) {
    //             this.image.setUrl(this.sessionImage);
    //           } else {
    //             this.image.setStream(async stream => {
    //               const res = await fetch(this.sessionImage);
    //               return res.body.pipe(stream);
    //             });
    //           }

    //           this.image.update().catch(this.error);
    //         }).catch(this.error);
    //       }
    //     } else {
    //       // Set Capabilities
    //       this.setCapabilityValue('speaker_track', null).catch(this.error);
    //       this.setCapabilityValue('speaker_artist', null).catch(this.error);
    //       this.setCapabilityValue('speaker_album', null).catch(this.error);

    //       // Set Image
    //       if (this.sessionImage !== null) {
    //         this.sessionImage = null;
    //         this.image.setUrl(null);
    //         this.image.update().catch(this.error);
    //       }
    //     }
    //   })
    //   .then(() => {
    //     this.setAvailable();
    //   })
    //   .catch(err => {
    //     this.error(err.message || err.toString());
    //     this.setUnavailable(err);
    //   });

    // Get Recently Added
    this.api.getLibraryRecentlyAdded()
      .then(items => {
        const previouslyMostRecentlyAddedAt = this.getStoreValue('mostRecentlyAddedAt');
        const mostRecentItem = items[0];
        if (!mostRecentItem) return;
        const mostRecentItemAddedAt = mostRecentItem.addedAt;

        // If nothing has changed
        if (previouslyMostRecentlyAddedAt === mostRecentItemAddedAt) {
          return;
        }

        // Set the new value
        this.setStoreValue('mostRecentlyAddedAt', mostRecentItemAddedAt).catch(this.error);

        // If this is the first time, stop here.
        // We don't want all existing items to be trigger as 'new'.
        if (previouslyMostRecentlyAddedAt === null) {
          return;
        }

        // Loop new items
        items
          .filter(item => {
            return item.addedAt > previouslyMostRecentlyAddedAt;
          })
          .forEach((item, i) => {
            const title = PlexUtil.getTitle(item);

            this.log(`Added: ${title}`);

            // Set Timeout to prevent Flow Rate Limits
            this.homey.setTimeout(() => {
              Promise.resolve().then(async () => {
                const image = await this.homey.images.createImage();
                const imageUrl = await (async () => {
                  const apiUrl = await this.api.url;

                  if (Array.isArray(item.Image)) {
                    const coverPoster = item.Image.find(image => image.type === 'coverPoster');
                    if (coverPoster) {
                      return `${apiUrl}${coverPoster.url}?X-Plex-Token=${this.api.token}`;
                    }
                  }

                  return `${apiUrl}${item.art}?X-Plex-Token=${this.api.token}`;
                })();
                image.setUrl(imageUrl);

                await this.homey.flow
                  .getDeviceTriggerCard('recently_added')
                  .trigger(this, {
                    title,
                    image,
                  })
              }).catch(this.error);
            }, i * 2000);
          });
      })
      .catch(err => {
        this.error(err.message || err.toString());
      });
  }

  async rescanLibrary({ key }) {
    await this.api.rescanLibrary({ key });
  }

  async refreshLibrary({ key }) {
    await this.api.refreshLibrary({ key });
  }

  async getLibrarySections() {
    return this.api.getLibrarySections();
  }

  async getLibraryRecentlyAdded() {
    const url = await this.api.url;
    return this.api.getLibraryRecentlyAdded()
      .then(items => {
        return items.map(item => ({
          title: PlexUtil.getTitle(item),
          image: `${url}${PlexUtil.getThumb(item)}?X-Plex-Token=${this.api.token}`,
        }));
      })
      .catch(err => {
        this.error(err.message || err.toString());
      });
  }

};
