const {fetchApi} = require('./util/fetch');
const Instance = require('./instance');
const InstanceUpdater = require('./instance-updater');
const uuidv4 = require('uuid/v4');
const Resumable = require('../resumable');
const util = require('util');
const fs = require('fs');
const path = require('path');

class File {
    constructor({filePath, type, size}) {
        this.path = filePath;
        this.name = path.basename(filePath);
        this.type = type;
        this.size = size;
    }

    slice(start, end, contentType) {
        return fs.createReadStream(this.path, {start, end});
    }
}

/**
 * @typedef {object} ProjectKey
 * @property {string} identifier
 * @property {string} label
 * @property {string} key
 * @property {'ssh'|'adb'} kind - public key
 * @property {string} fingerprint
 * @property {string} createdAt - ISO datetime string
 * @property {string} updatedAt - ISO datetime string
 */

/**
 * @typedef {object} ProjectQuotas
 * @property {number} cores - Number of available CPU cores
 */

/**
 * Instances of this class are returned from {@link Corellium#projects}, {@link
 * Corellium#getProject}, and {@link Corellium#projectNamed}. They should not
 * be created using the constructor.
 * @hideconstructor
 */
class Project {
    constructor(client, id) {
        this.client = client;
        this.api = this.client.api;
        this.id = id;
        this.token = null;
        this.updater = new InstanceUpdater(this);
    }

    /**
     * Reload the project info. This currently consists of name and quotas, but
     * will likely include more in the future.
     */
    async refresh() {
        this.info = await fetchApi(this, `/projects/${this.id}`);
    }

    async getToken() {
        return await this.client.getToken();
    }

    /**
     * Returns an array of the {@link Instance}s in this project.
     * @returns {Promise<Instance[]>} The instances in this project
     * @example <caption>Finding the first instance with a given name</caption>
     * const instances = await project.instances();
     * const instance = instances.find(instance => instance.name === 'Test Device');
     */
    async instances() {
        const instances = await fetchApi(this, `/projects/${this.id}/instances`);
        return await Promise.all(instances.map(info => new Instance(this, info)));
    }

    /**
     * Returns the {@link Instance} with the given ID.
     * @param {string} id
     * @returns {Promise<Instance>}
     */
    async getInstance(id) {
        const info = await fetchApi(this, `/instances/${id}`);
        return new Instance(this, info);
    }

    /**
     * Creates an instance and returns the {@link Instance} object. The options
     * are passed directly to the API.
     *
     * @param {Object} options - The options for instance creation. These are
     * the same as the JSON options passed to the instance creation API
     * endpoint. For a full list of possible options, see the API documentation.
     * @param {string} options.flavor - The device flavor, such as `iphone6`
     * @param {string} options.os - The device operating system version
     * @param {string} options.ipsw - The ID of a previously uploaded image in the project to use as the firmware
     * @param {string} [options.name] - The device name
     * @param {Object} [options.bootOptions] - Boot options for the instance
     * @param {string|string[]} [options.patches] - Instance patches, such as `jailbroken` (default)
     * @returns {Promise<Instance>}
     *
     * @example <caption>Creating an instance and waiting for it to start its first boot</caption>
     * const instance = await project.createInstance({
     *     flavor: 'iphone6',
     *     os: '11.3',
     *     name: 'Test Device',
     * });
     * await instance.finishRestore();
     */
    async createInstance(options) {
        const {id} = await fetchApi(this, '/instances', {
            method: 'POST',
            json: Object.assign({}, options, {project: this.id}),
        });
        return await this.getInstance(id);
    }

    /**
     * Get the VPN configuration to connect to the project network. This is only
     * available for cloud. At least one instance must be on in the project.
     *
     * @param {string} type -       Could be either "ovpn" or "tblk" to select between OpenVPN and TunnelBlick configuration formats.
     *                              TunnelBlick files are delivered as a ZIP file and OpenVPN configuration is just a text file.
     * @param {string} clientUUID - An arbitrary UUID to uniquely associate this VPN configuration with so it can be later identified
     *                              in a list of connected clients. Optional.
     * @returns {Promise<Buffer>}
     */
    async vpnConfig(type = 'ovpn', clientUUID) {
        if (!clientUUID)
            clientUUID = uuidv4();

        const response = await fetchApi(this, `/projects/${this.id}/vpn-configs/${clientUUID}.${type}`, {response: 'raw'});
        return await response.buffer();
    }

    /** Destroy this project. */
    async destroy() {
        return await fetchApi(this, `/projects/${this.id}`, {
            method: 'DELETE'
        });
    }

    /**
     * The project quotas.
     * @returns {ProjectQuotas}
     */
    get quotas() {
        return this.info.quotas;
    }

    set quotas(quotas) {
        this.setQuotas(quotas);
    }

    /**
     * Sets the project quotas. Only the cores property is currently respected.
     *
     * @param {ProjectQuotas} quotas
     */
    async setQuotas(quotas) {
        this.info.quotas = Object.assign({}, this.info.quotas, quotas);
        await fetchApi(this, `/projects/${this.id}`, {
            method: 'PATCH',
            json: {
                quotas: {
                    cores: quotas.cores || quotas.cpus
                }
            }
        });
    }

    /**
     * How much of the project's quotas are currently used. To ensure this information is up to date, call {@link Project#refresh()} first.
     * @property {number} cores - Number of used CPU cores
     */
    get quotasUsed() {
        return this.info.quotasUsed;
    }

    /** The project's name. */
    get name() {
        return this.info.name;
    }

    /**
     * Returns a list of {@link Role}s associated with this project, showing who has permissions over this project.
     *
     * This function is only available to domain and project administrators.
     */
    async roles() {
        const roles = await this.client.roles();
        return roles.get(this.id);
    }

    /**
     * Give permissions to this project for a {@link Team} or a {@link User} (adds a {@link Role}).
     *
     * This function is only available to domain and project administrators.
     */
    async createRole(grantee, type = 'user') {
        await this.client.createRole(this.id, grantee, type);
    }

    /**
     * Returns a list of authorized keys associated with the project. When a new
     * instance is created in this project, its authorized_keys (iOS) or adbkeys
     * (Android) will be populated with these keys by default. Adding or
     * removing keys from the project will have no effect on existing instances.
     *
     * @returns {Promise<ProjectKey[]>}
     */
    async keys() {
        return await this.client.projectKeys(this.id);
    }

    /**
     * Add a public key to project.
     *
     * @param {string} key - the public key, as formatted in a .pub file
     * @param {'ssh'|'adb'} kind
     * @param {string} [label] - defaults to the public key comment, if present
     *
     * @returns {Promise<ProjectKey>}
     */
    async addKey(key, kind='ssh', label=null) {
        return await this.client.addProjectKey(this.id, key, kind, label);
    }

    /**
     * @param {string} keyId
     */
    async deleteKey(keyId) {
        return await this.client.deleteProjectKey(this.id, keyId);
    }

    /**
     * Add an image to the project. These images may be removed at any time and are meant to facilitate creating a new Instance with images.
     *
     * @param {string} id - UUID of the image to create. Required to be universally unique but can be user-provided. You may resume uploads if you provide the same UUID.
     * @param {string} type - E.g. fw for the main firmware image.
     * @param {string} path - The path on the local file system to get the file.
     * @param {string} name - The name of the file to identify the file on the server. Usually the basename of the path.
     * @param {Project~progressCallback} [progress] - The callback for file upload progress information.
     *
     * @returns {Promise<ProjectKey>}
     */
    async uploadImage(id, type, path, name, progress) {
        const token = await this.getToken();
        return new Promise(async (resolve, reject) => {
            const url =  this.api + '/projects/' + encodeURIComponent(this.id) + '/image-upload/' + encodeURIComponent(type) + '/' + encodeURIComponent(id) + '/' + encodeURIComponent(name);
            const r = new Resumable({
                target: url,
                headers: {
                    'Authorization': token 
                },
                uploadMethod: 'PUT',
                chunkSize: 5 * 1024 * 1024,
                prioritizeFirstAndLastChunk: true,
                method: 'octet'
            });

            r.on('fileAdded', (file, event) => {
                r.upload();
            });

            r.on('progress', () => {
                if (progress)
                    progress(r.progress());
            });

            r.on('fileError', (a, b) => {
                console.log('gadgsa', a, b);
                reject();
            });

            r.on('fileSuccess', () => {
                resolve();
            });

            const stat = await util.promisify(fs.stat)(path);
            const file = new File({filePath: path, type: 'application/octet-stream', size: stat.size});
            r.addFile(file);
        });
    }
}

module.exports = Project;
