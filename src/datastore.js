'use strict';

import {
   MUTABLE_DATUM_DIR_TYPE,
   MUTABLE_DATUM_FILE_TYPE,
   DATASTORE_SCHEMA,
   DATASTORE_RESPONSE_SCHEMA,
   MUTABLE_DATUM_INODE_SCHEMA,
   MUTABLE_DATUM_DIR_IDATA_SCHEMA,
   MUTABLE_DATUM_EXTENDED_RESPONS_SCHEMA,
   SUCCESS_FAIL_SCHEMA,
   DATASTORE_LOOKUP_RESPONSE_SCHEMA,
   DATASTORE_LOOKUP_EXTENDED_RESPONSE_SCHEMA,
   CORE_ERROR_SCHEMA,
} from './schemas';

import {
   makeFileInodeBlob,
   makeDirInodeBlob,
   makeMutableDataInfo,
   signDataPayload,
   signRawData,
   hashDataPayload,
   inodeDirLink,
   inodeDirUnlink,
   decodePrivateKey,
   makeInodeTombstones,
   makeMutableDataTombstones,
   signMutableDataTombstones,
   getChildVersion,
} from './inode';

import {
   jsonStableSerialize
} from './util';

const http = require('http');
const uuid4 = require('uuid/v4');
const bitcoinjs = require('bitcoinjs-lib');
const BigInteger = require('bigi');
const Promise = require('promise');
const assert = require('assert');
const Ajv = require('ajv');

const ENOENT = 2;
const EACCES = 13;
const EEXIST = 17;
const ENOTDIR = 20;
const EREMOTEIO = 121;


/*
 * Helper method to validate a JSON response
 * against a schema.  Returns the validated object
 * on success, and throw an exception on error.
 */
function validateJSONResponse(resp, result_schema) {

   const ajv = new Ajv();
   if (result_schema) {
      try {
         const valid = ajv.validate(result_schema, resp);
         assert(valid);
         return resp;
      }
      catch(e) {
         try {
            // error message
            const valid = ajv.validate(CORE_ERROR_SCHEMA, resp);
            assert(valid);
            return resp;
         }
         catch(e2) {
            console.log("Failed to validate with desired schema");
            console.log(e.stack);
            console.log("Failed to validate with error schema");
            console.log(e2.stack);
            console.log("Desired schema:");
            console.log(result_schema);
            console.log("Parsed message:");
            console.log(resp);
            throw new Error("Invalid core message");
         }
      }
   }
   else {
      return resp;
   }
}


/*
 * Helper method to issue an HTTP request.
 * @param options (Object) set of HTTP request options
 * @param result_schema (Object) JSON schema of the expected result 
 *
 * Pass 'bytes' for result_schema if you expect application/octet-stream
 * instead of application/json.
 */
function httpRequest(options, result_schema, body) {

    if (body) {
       options['body'] = body;
    }

    const url = `http://${options.host}:${options.port}${options.path}`;
    return fetch(url, options).then(
      (response) => {

         if(response.status >= 500) {
            throw Error(response.statusText);
         }

         if(response.status === 404) {
            return {'error': 'No such file or directory', 'errno': ENOENT};
         }

         if(response.status === 403) {
            return {'error': 'Access denied', 'errno': EACCES};
         }

         if(response.status === 401) {
            return {'error': 'Invalid request', 'errno': EINVAL};
         }

         let resp = null;
         if (response.headers.get('content-type') === 'application/json') {
            return response.json().then( (resp) => {
               return validateJSONResponse(resp, result_schema);
            });
         }
         else {
            return response.text();
         }
      } 
    );
}


/*
 * Convert a datastore public key to its ID.
 * @param ds_public_key (String) hex-encoded ECDSA public key
 */
export function datastoreGetId( ds_public_key_hex) {
    let ec = bitcoinjs.ECPair.fromPublicKeyBuffer( Buffer.from(ds_public_key_hex, 'hex') );
    return ec.getAddress();
}


/*
 * Get a public key (hex) from private key
 */
function getPubkeyHex(privkey_hex) {
   let privkey = BigInteger.fromBuffer( decodePrivateKey(privkey_hex) );
   let public_key = new bitcoinjs.ECPair(privkey).getPublicKeyBuffer().toString('hex');
   return public_key;
}


/*
 * Get device list from device IDs
 */
function getDeviceList(device_ids) {
   const escaped_device_ids = [];
   for (let devid of device_ids) {
      escaped_device_ids.push(escape(devid));
   }
   const res = escaped_device_ids.join(',');
   return res;
}


/*
 * Sanitize a path.  Consolidate // to /, and resolve foo/../bar to bar
 * @param path (String) the path
 *
 * Returns the sanitized path.
 */
export function sanitizePath( path) {
   
    const parts = path.split('/').filter(function(x) {return x.length > 0;});
    const retparts = [];

    for(let i = 0; i < parts.length; i++) {
       if (parts[i] === '..') {
          retparts.pop();
       }
       else {
          retparts.push(parts[i]);
       }
    }

    return '/' + retparts.join('/');
}


/*
 * Given a path, get the parent directory.
 *
 * @param path (String) the path.  Must be sanitized
 */
export function dirname(path) {
    return '/' + path.split('/').slice(0, -1).join('/');
}


/*
 * Given a path, get the base name
 *
 * @param path (String) the path. Must be sanitized
 */
export function basename(path) {
   return path.split('/').slice(-1)[0];
}


/*
 * Given a host:port string, split it into
 * a host and port
 *
 * @param hostport (String) the host:port
 * 
 * Returns an object with:
 *      .host
 *      .port
 */
function splitHostPort(hostport) {

   let host = hostport;
   let port = 80;
   const parts = hostport.split(':');
   if (parts.length > 1) {
      host = parts[0];
      port = parts[1];
   }

   return {'host': host, 'port': port};
}


/*
 * Create the signed request to create a datastore.
 * This information can be fed into datastoreCreate()
 * Returns an object with:
 *      .datastore_info: datastore information
 *      .datastore_sigs: signatures over the above.
 */
export function datastoreCreateRequest( ds_type, ds_private_key_hex, drivers, device_id, all_device_ids) {

   assert(ds_type === 'datastore' || ds_type === 'collection');
   const root_uuid = uuid4();
   
   const ds_public_key = getPubkeyHex(ds_private_key_hex);
   const datastore_id = datastoreGetId( ds_public_key );
   const root_blob_info = makeDirInodeBlob( datastore_id, datastore_id, root_uuid, {}, device_id, 1 );

   // actual datastore payload
   const datastore_info = {
      'type': ds_type,
      'pubkey': ds_public_key,
      'drivers': drivers,
      'device_ids': all_device_ids,
      'root_uuid': root_uuid,
   };
    
   const data_id = `${datastore_id}.datastore`;
   const datastore_blob = makeMutableDataInfo( data_id, jsonStableSerialize(datastore_info), device_id, 1 );

   const datastore_str = jsonStableSerialize(datastore_blob);

   // sign them all
   const root_sig = signDataPayload( root_blob_info.header, ds_private_key_hex );
   const datastore_sig = signDataPayload( datastore_str, ds_private_key_hex );

   // make and sign tombstones for the root
   const root_tombstones = makeInodeTombstones(datastore_id, root_uuid, all_device_ids);
   const signed_tombstones = signMutableDataTombstones(root_tombstones, ds_private_key_hex);

   const info = {
      'datastore_info': {
         'datastore_id': datastore_id,
         'datastore_blob': datastore_str, 
         'root_blob_header': root_blob_info.header,
         'root_blob_idata': root_blob_info.idata,
      },
      'datastore_sigs': {
         'datastore_sig': datastore_sig, 
         'root_sig': root_sig, 
      },
      'root_tombstones': signed_tombstones,
   };

   return info;
}


/*
 * Create a datastore
 * Asynchronous; returns a Promise
 *
 * Returns an async object whose .end() method returns a datastore object.
 * The returned object has the following properties:
 *      
 */
export function datastoreCreate( blockstack_hostport, blockstack_session_token, datastore_request) {
    
   const payload = {
      'datastore_info': {
          'datastore_blob': datastore_request.datastore_info.datastore_blob,
          'root_blob_header': datastore_request.datastore_info.root_blob_header,
          'root_blob_idata': datastore_request.datastore_info.root_blob_idata,
      },
      'datastore_sigs': {
          'datastore_sig': datastore_request.datastore_sigs.datastore_sig,
          'root_sig': datastore_request.datastore_sigs.root_sig,
      },
      'root_tombstones': datastore_request.root_tombstones,
   };

   const hostinfo = splitHostPort(blockstack_hostport);

   const options = {
      'method': 'POST',
      'host': hostinfo.host,
      'port': hostinfo.port,
      'path': '/v1/stores'
   };

   if (blockstack_session_token) {
      options['headers'] = {'Authorization': `bearer ${blockstack_session_token}`};
   } 

   const body = JSON.stringify(payload);
   options['headers']['Content-Type'] = 'application/json';
   options['headers']['Content-Length'] = body.length;

   return httpRequest(options, SUCCESS_FAIL_SCHEMA, body);
}


/*
 * Generate the data needed to delete a datastore.
 *
 * @param ds (Object) a datastore context
 * @param privkey (String) the hex-encoded datastore private key
 *
 * Returns an object to be given to datastoreDelete()
 */
export function datastoreDeleteRequest(ds) {
   const datastore_id = ds.datastore_id;
   const device_ids = ds.datastore.device_ids;
   const root_uuid = ds.datastore.root_uuid;
   const data_id = `${datastore_id}.datastore`;

   const tombstones = makeMutableDataTombstones( device_ids, data_id );
   const signed_tombstones = signMutableDataTombstones( tombstones, ds.privkey_hex );

   const root_tombstones = makeInodeTombstones(datastore_id, root_uuid, device_ids);
   const signed_root_tombstones = signMutableDataTombstones( root_tombstones, ds.privkey_hex );

   const ret = {
      'datastore_tombstones': signed_tombstones,
      'root_tombstones': signed_root_tombstones,
   };

   return ret;
}

/*
 * Delete a datastore
 *
 * @param ds (Object) a datastore context
 * @param ds_tombstones (Object) OPTINOAL: signed information from datastoreDeleteRequest()
 * @param root_tombstones (Object) OPTINAL: signed information from datastoreDeleteRequest()
 *
 * Asynchronous; returns a Promise
 */
export function datastoreDelete(ds, ds_tombstones, root_tombstones) {
   
   if (!ds_tombstones || !root_tombstones) {
      const delete_info = datastoreDeleteRequest(ds);
      ds_tombstones = delete_info['datastore_tombstones'];
      root_tombstones = delete_info['root_tombstones'];
   }

   const device_list = getDeviceList(ds.datastore.device_ids);
   const payload = {
      'datastore_tombstones': ds_tombstones,
      'root_tombstones': root_tombstones,
   };

   const options = {
      'method': 'DELETE',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores?device_ids=${device_list}`
   };

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   } 

   const body = JSON.stringify(payload);
   options['headers']['Content-Type'] = 'application/json';
   options['headers']['Content-Length'] = body.length;

   return httpRequest(options, SUCCESS_FAIL_SCHEMA, body);
}


/*
 * Look up a datastore and establish enough contextual information to do subsequent storage operations.
 * Asynchronous; returns a Promise
 *
 * Returns an async object whose .end() method returns a datastore connection,
 * with the following properties:
 *      .host: blockstack host
 *      .datastore: datastore object
 */
export function datastoreConnect(blockstack_hostport, blockstack_session_token, datastore_id, data_privkey_hex, device_id) {

   if (data_privkey_hex) {
      datastore_id = datastoreGetId(getPubkeyHex(data_privkey_hex));
   }

   const hostinfo = splitHostPort(blockstack_hostport);
   
   const ctx = {
      'host': hostinfo.host,
      'port': hostinfo.port,
      'session_token': blockstack_session_token,
      'device_id': device_id,
      'datastore_id': datastore_id,
      'privkey_hex': data_privkey_hex,
      'datastore': null,
   };

   const options = {
      'method': 'GET',
      'host': hostinfo.host,
      'port': hostinfo.port,
      'path': `/v1/stores/${datastore_id}?device_ids=${device_id}`,
   }

   if (blockstack_session_token) {
      options['headers'] = {'Authorization': `bearer ${blockstack_session_token}`};
   }

   return httpRequest(options, DATASTORE_RESPONSE_SCHEMA).then((ds) => {
      if (!ds || ds.error) {
         console.log(`failed to get datastore: ${JSON.stringify(ds)}`);
         return ds;
      }
      else {
         ctx['datastore'] = ds.datastore;
         return ctx;
      }
   });
}


/*
 * Connect to or create a datastore.
 * Asynchronous, returns a Promise
 *
 * @param hostport (String) "host:port" string
 * @param drivers (Array) a list of all drivers this datastore will use, if we create it.
 * @param privkey (String) OPTIONAL: hex-encoded ECDSA private key
 * @param session (String) OPTIONAL: the Blockstack Core session
 * @param this_device_id (String) OPTIONAL: a unique identifier for this device.
 * @param all_device_ids (Array) OPTIONAL: all devices who can put data to this datastore, if we create it.
 *
 * Returns a Promise that yields a datastore connection, or an error object with .error defined.
 *
 */
export function datastoreConnectOrCreate(hostport, drivers, privkey=null, session=null, this_device_id=null, all_device_ids=[]) {
   
   if(!privkey) {
      const userData = window.localStorage.getItem("blockstack");
      privkey = userData.privkey;
      assert(privkey);
   }

   if(!session) {
      const userData = window.localStorage.getItem("blockstack");
      session = userData.session;
      assert(session);
   }

   if(!this_device_id) {
      const userData = window.localStorage.getItem("blockstack");
      this_device_id = userData.localDeviceId;
      assert(this_device_id);
   }

   if(!all_device_ids || all_device_ids.length == 0) {
      const userData = window.localStorage.getItem("blockstack");
      all_device_ids = userDta.allDeviceIds;
      assert(all_device_ids);
      assert(all_device_ids.length > 0);
   }

   return datastoreConnect(hostport, session, null, privkey, this_device_id).then(
      (datastore_ctx) => {
         if (datastore_ctx.error && datastore_ctx.errno === ENOENT) {
            // does not exist
            console.log("Datastore does not exist; creating...");

            const info = datastoreCreateRequest('datastore', privkey, drivers, this_device_id, all_device_ids );

            // go create it
            return datastoreCreate( hostport, session, info ).then(
               (res) => {
                  if (res.error) {
                     console.log(res.error);
                     return res;
                  }

                  // connect to it now
                  return datastoreConnect( hostport, session, null, privkey, this_device_id );
               },
               (error) => {
                  console.log(error);
                  return {'error': 'Failed to create datastore'}
               });

         }
         else {
            // exists
            return datastore_ctx;
         }
      },

      (error) => {
         console.log(error);
         return {'error': 'Failed to connect to storage endpoint'}
      }
   );
}


/*
 * Path lookup 
 * 
 * @param ds (Object) a datastore context
 * @param path (String) the path to the inode
 * @param opts (Object) optional arguments:
 *      .extended (Bool) whether or not to include the entire path's inode information
 *      .force (Bool) if True, then ignore stale inode errors.
 *      .idata (Bool) if True, then get the inode payload as well
 *
 * Asynchronos; call .end() on the returned object.
 */
export function lookup(ds, path, opts) {

   const datastore_id = ds.datastore_id;
   const device_list = getDeviceList(ds.datastore.device_ids);
   const options = {
      'method': 'GET',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores/${datastore_id}/inodes?path=${escape(sanitizePath(path))}&device_ids=${device_list}`,
   };

   if (!opts) {
      opts = {};
   }

   let schema = DATASTORE_LOOKUP_RESPONSE_SCHEMA;

   if (opts.extended) {
      options['path'] += '&extended=1';
      schema = DATASTORE_LOOKUP_EXTENDED_RESPONSE_SCHEMA;
   }

   if (opts.force) {
      options['path'] += '&force=1';
   }

   if (opts.idata) {
      options['idata'] += '&idata=1';
   }


   return httpRequest(options, schema);
}
    

/*
 * List a directory.
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the directory to list
 * @param opts (Object) optional arguments:
 *      .extended (Bool) whether or not to include the entire path's inode inforamtion
 *      .force (Bool) if True, then ignore stale inode errors.
 *
 * Asynchronous; returns a Promise
 */
export function listDir(ds, path, opts) {

   const datastore_id = ds.datastore_id;
   const device_list = getDeviceList(ds.datastore.device_ids);
   const options = {
      'method': 'GET',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores/${datastore_id}/directories?path=${escape(sanitizePath(path))}&idata=1&device_ids=${device_list}`,
   };

   let schema = MUTABLE_DATUM_DIR_IDATA_SCHEMA;

   if (!opts) {
      opts = {};
   }

   if (opts.extended) {
      options['path'] += '&extended=1';
      schema = MUTABLE_DATUM_EXTENDED_RESPONSE_SCHEMA;
   }

   if (opts.force) {
      optsion['path'] += '&force=1';
   }

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   }

   return httpRequest(options, schema);
}


/* 
 * Stat a file or directory (i.e. get the inode header)
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the directory to list
 * @param opts (Object) optional arguments:
 *      .extended (Bool) whether or not to include the entire path's inode inforamtion
 *      .force (Bool) if True, then ignore stale inode errors.
 *
 * Asynchronous; returns a Promise
 */
export function stat(ds, path, opts) {

   const datastore_id = ds.datastore_id;
   const device_list = getDeviceList(ds.datastore.device_ids);
   const options = {
      'method': 'GET',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores/${datastore_id}/inodes?path=${escape(sanitizePath(path))}&device_ids=${device_list}`,
   };

   let schema = MUTABLE_DATUM_INODE_SCHEMA;

   if (!opts) {
      opts = {};
   }

   if (opts.extended) {
      options['path'] += '&extended=1';
      schema = MUTABLE_DATUM_EXTENDED_RESPONSE_SCHEMA;
   }
   
   if (opts.force) {
      optsion['path'] += '&force=1';
   }

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   } 

   return httpRequest(options, schema);
}


/* 
 * Get an undifferentiated file or directory and its data.
 * Low-level method, not meant for external consumption.
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the directory to list
 * @param opts (Object) optional arguments:
 *      .extended (Bool) whether or not to include the entire path's inode inforamtion
 *      .force (Bool) if True, then ignore stale inode errors.
 *
 * Asynchronous; returns a Promise
 */
function getInode(ds, path, opts) {

   const datastore_id = ds.datastore_id;
   const device_list = getDeviceList(ds.datastore.device_ids);
   const options = {
      'method': 'GET',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores/${datastore_id}/inodes?path=${escape(sanitizePath(path))}&idata=1&device_ids=${device_list}`,
   };

   let schema = MUTABLE_DATUM_INODE_SCHEMA;

   if (!opts) {
      opts = {};
   }

   if (opts.extended) {
      options['path'] += '&extended=1';
      schema = MUTABLE_DATUM_EXTENDED_RESPONSE_SCHEMA;
   }
   
   if (opts.force) {
      options['path'] += '&force=1';
   }

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   } 

   return httpRequest(options, schema);
}


/*
 * Get a file.
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the file to read
 * @param opts (Object) optional arguments:
 *      .extended (Bool) whether or not to include the entire path's inode inforamtion
 *      .force (Bool) if True, then ignore stale inode errors.
 *
 * Asynchronous; returns a Promise
 */
export function getFile(ds, path, opts) {

   const datastore_id = ds.datastore_id;
   const device_list = getDeviceList(ds.datastore.device_ids);
   const options = {
      'method': 'GET',
      'host': ds.host,
      'port': ds.port,
      'path': `/v1/stores/${datastore_id}/files?path=${escape(sanitizePath(path))}&idata=1&device_ids=${device_list}`,
   };

   let schema = SUCCESS_FAIL_SCHEMA;

   if (!opts) {
      opts = {};
   }

   if (opts.extended) {
      options['path'] += '&extended=1';
      schema = MUTABLE_DATUM_EXTENDED_RESPONSE_SCHEMA;
   }

   if (opts.force) {
      options['path'] += '&force=1';
   }

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   }

   return httpRequest(options, schema);
}


/*
 * Execute a datastore operation
 *
 * @param ds (Object) a datastore context 
 * @param operation (String) the specific operation being carried out.
 * @param path (String) the path of the operation
 * @param inodes (Array) the list of inode headers to replicate
 * @param payloads (Array) the list of inode payloads in 1-to-1 correspondence to the headers
 * @param signatures (Array) the list of signatures over each inode header (also 1-to-1 correspondence)
 * @param tombstones (Array) the list of signed inode tombstones
 *
 * Asynchronous; returns a Promise
 */
function datastoreOperation(ds, operation, path, inodes, payloads, signatures, tombstones) {

   let request_path = null;
   let http_operation = null;
   const datastore_id = ds.datastore_id;
   const datastore_privkey = ds.privkey_hex;
   const device_list = getDeviceList(ds.datastore.device_ids);

   assert(inodes.length === payloads.length);
   assert(payloads.length === signatures.length);

   if (operation === 'mkdir') {
      request_path = `/v1/stores/${datastore_id}/directories?path=${escape(sanitizePath(path))}&device_ids=${device_list}`;
      http_operation = 'POST';

      assert(inodes.length === 2);
   }
   else if (operation === 'putFile') {
      request_path = `/v1/stores/${datastore_id}/files?path=${escape(sanitizePath(path))}&device_ids=${device_list}`;
      http_operation = 'PUT';

      assert(inodes.length === 1 || inodes.length === 2);
   }
   else if (operation === 'rmdir') {
      request_path = `/v1/stores/${datastore_id}/directories?path=${escape(sanitizePath(path))}`;
      http_operation = 'DELETE';

      assert(inodes.length === 1);
      assert(tombstones.length >= 1);
   }
   else if (operation === 'deleteFile') {
      request_path = `/v1/stores/${datastore_id}/files?path=${escape(sanitizePath(path))}`;
      http_operation = 'DELETE';

      assert(inodes.length === 1);
      assert(tombstones.length >= 1);
   }
   else {
      console.log(`invalid operation ${operation}`);
      assert(0);
   }

   const options = {
      'method': http_operation,
      'host': ds.host,
      'port': ds.port,
      'path': request_path,
   };

   if (ds.session_token) {
      options['headers'] = {'Authorization': `bearer ${ds.session_token}`};
   }

   const datastore_str = JSON.stringify(ds.datastore);
   const datastore_sig = signRawData( datastore_str, datastore_privkey ); 

   const body_struct = {
      'inodes': inodes,
      'payloads': payloads,
      'signatures': signatures,
      'tombstones': tombstones,
      'datastore_str': datastore_str,
      'datastore_sig': datastore_sig,
   }

   const body = JSON.stringify(body_struct);
   options['headers']['Content-Type'] = 'application/json';
   options['headers']['Content-Length'] = body.length;

   return httpRequest(options, SUCCESS_FAIL_SCHEMA, body);
}


/*
 * Given a path, get its parent directory
 * Make sure it's a directory.
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the inode in question
 * @param opts (Object) lookup options
 *
 * Asynchronous; returns a Promise
 */
export function getParent(ds, path, opts) {
   const dirpath = dirname(path);
   return getInode(ds, dirpath, opts).then(
      (inode) => {
         if (!inode) {
            return {'error': 'Failed to get parent', 'errno': EREMOTEIO};
         }
         if (inode.type !== MUTABLE_DATUM_DIR_TYPE) {
            return {'error': 'Not a directory', 'errno': ENOTDIR}
         }
         else {
            return inode;
         }
      },
      (error_resp) => {
         return {'error': 'Failed to get inode', 'errno': EREMOTEIO};
      }
   );
}


/*
 * Create or update a file
 *
 * @param ds (Object) a datastore context
 * @param path (String) the path to the file to create (must not exist)
 * @param file_buffer (Buffer or String) the file contents
 *
 * Asynchronous; returns a Promise
 */
export function putFile(ds, path, file_buffer) {

   const datastore_id = ds.datastore_id;
   const device_id = ds.device_id;
   const privkey_hex = ds.privkey_hex;

   path = sanitizePath(path);
   const child_name = basename(path);

   assert(typeof(file_buffer) === 'string' || (file_buffer instanceof Buffer));

   // get parent dir 
   return getParent(ds, path).then(
      (parent_dir) => {
         
         if (parent_dir.error) {
            return parent_dir;
         }

         // make the file inode information
         let file_payload = file_buffer;
         let file_hash = null;
         if (typeof(file_payload) !== 'string') {
            // buffer
            file_payload = file_buffer.toString('base64');
            file_hash = hashDataPayload( file_buffer.toString() );
         }
         else {
            // string
            file_payload = Buffer.from(file_buffer).toString('base64');
            file_hash = hashDataPayload( file_buffer );
         }

         assert(file_hash);

         let inode_uuid = null;
         let new_parent_dir_inode = null;
         let child_version = null;

         // new or existing?
         if (Object.keys(parent_dir['idata']['children']).includes(child_name)) {

            // existing; no directory change
            inode_uuid = parent_dir['idata']['children'][child_name]['uuid'];
            new_parent_dir_inode = inodeDirLink(parent_dir, MUTABLE_DATUM_FILE_TYPE, child_name, inode_uuid, true );
         }
         else {

            // new 
            inode_uuid = uuid4();
            new_parent_dir_inode = inodeDirLink(parent_dir, MUTABLE_DATUM_FILE_TYPE, child_name, inode_uuid, false );
         }

         const version = getChildVersion(parent_dir, child_name);
         const inode_info = makeFileInodeBlob( datastore_id, datastore_id, inode_uuid, file_hash, device_id, version );
         const inode_sig = signDataPayload( inode_info['header'], privkey_hex );

         // make the directory inode information
         const new_parent_info = makeDirInodeBlob( datastore_id, new_parent_dir_inode['owner'], new_parent_dir_inode['uuid'], new_parent_dir_inode['idata']['children'], device_id, new_parent_dir_inode['version'] + 1);
         const new_parent_sig = signDataPayload( new_parent_info['header'], privkey_hex );

         // post them
         const new_parent_info_b64 = new Buffer(new_parent_info['idata']).toString('base64');
         return datastoreOperation(ds, 'putFile', path, [inode_info['header'], new_parent_info['header']], [file_payload, new_parent_info_b64], [inode_sig, new_parent_sig], []);
      },
   );
}


/*
 * Create a directory.
 *
 * @param ds (Object) datastore context
 * @param path (String) path to the directory
 *
 * Asynchronous; returns a Promise
 */
export function mkdir(ds, path, parent_dir) {

   const datastore_id = ds.datastore_id;
   const device_id = ds.device_id;
   const privkey_hex = ds.privkey_hex;

   path = sanitizePath(path);
   const child_name = basename(path);

   return getParent(ds, path).then(
      (parent_dir) => {

         if (parent_dir.error) {
            return parent_dir;
         }

         // must not exist 
         if (Object.keys(parent_dir['idata']['children']).includes(child_name)) {
            return {'error': 'File or directory exists', 'errno': EEXIST};
         }

         // make the directory inode information 
         const inode_uuid = uuid4();
         const inode_info = makeDirInodeBlob( datastore_id, datastore_id, inode_uuid, {}, device_id);
         const inode_sig = signDataPayload( inode_info['header'], privkey_hex );

         // make the new parent directory information 
         const new_parent_dir_inode = inodeDirLink(parent_dir, MUTABLE_DATUM_DIR_TYPE, child_name, inode_uuid);
         const new_parent_info = makeDirInodeBlob( datastore_id, new_parent_dir_inode['owner'], new_parent_dir_inode['uuid'], new_parent_dir_inode['idata']['children'], device_id, new_parent_dir_inode['version'] + 1);
         const new_parent_sig = signDataPayload( new_parent_info['header'], privkey_hex );

         // post them 
         return datastoreOperation(ds, 'mkdir', path, [inode_info['header'], new_parent_info['header']], [inode_info['idata'], new_parent_info['idata']], [inode_sig, new_parent_sig], []);
      },
   );
}


/*
 * Delete a file 
 *
 * @param ds (Object) datastore context
 * @param path (String) path to the directory
 * @param parent_dir (Object) (optional) parent directory inode
 *
 * Asynchronous; returns a Promise
 */
export function deleteFile(ds, path, parent_dir) {

   const datastore_id = ds.datastore_id;
   const device_id = ds.device_id;
   const privkey_hex = ds.privkey_hex;
   const all_device_ids = ds.datastore.device_ids;

   path = sanitizePath(path);
   const child_name = basename(path);

   return getParent(ds, path).then(
      (parent_dir) => {
         if (parent_dir.error) {
            return parent_dir;
         }

         // no longer exists?
         if (!Object.keys(parent_dir['idata']['children']).includes(child_name)) {
            return {'error': 'No such file or directory', 'errno': ENOENT};
         }

         const inode_uuid = parent_dir['idata']['children'][child_name];

         // unlink 
         const new_parent_dir_inode = inodeDirUnlink(parent_dir, child_name);
         const new_parent_info = makeDirInodeBlob( datastore_id, new_parent_dir_inode['owner'], new_parent_dir_inode['uuid'], new_parent_dir_inode['idata']['children'], device_id, new_parent_dir_inode['version'] + 1 );
         const new_parent_sig = signDataPayload( new_parent_info['header'], privkey_hex );

         // make tombstones 
         const tombstones = makeInodeTombstones(datastore_id, inode_uuid, all_device_ids);
         const signed_tombstones = signMutableDataTombstones(tombstones, privkey_hex);
   
         // post them 
         return datastoreOperation(ds, 'deleteFile', path, [new_parent_info['header']], [new_parent_info['idata']], [new_parent_sig], signed_tombstones);
      }
   );
}


/*
 * Remove a directory 
 *
 * @param ds (Object) datastore context
 * @param path (String) path to the directory
 * @param parent_dir (Object) (optional) parent directory inode
 *
 * Asynchronous; returns a Promise
 */
export function rmdir(ds, path, parent_dir) {

   const datastore_id = ds.datastore_id;
   const device_id = ds.device_id;
   const privkey_hex = ds.privkey_hex;
   const all_device_ids = ds.datastore.device_ids;

   path = sanitizePath(path);
   const child_name = basename(path);

   return getParent(ds, path).then(
      (parent_dir) => {
         if (parent_dir.error) {
            return parent_dir;
         }

         // no longer exists?
         if (!Object.keys(parent_dir['idata']['children']).includes(child_name)) {
            return {'error': 'No such file or directory', 'errno': ENOENT};
         }

         const inode_uuid = parent_dir['idata']['children'][child_name];

         // unlink 
         const new_parent_dir_inode = inodeDirUnlink(parent_dir, child_name);
         const new_parent_info = makeDirInodeBlob( datastore_id, new_parent_dir_inode['owner'], new_parent_dir_inode['uuid'], new_parent_dir_inode['idata']['children'], device_id, new_parent_dir_inode['version'] + 1 );
         const new_parent_sig = signDataPayload( new_parent_info['header'], privkey_hex );

         // make tombstones 
         const tombstones = makeInodeTombstones(datastore_id, inode_uuid, all_device_ids);
         const signed_tombstones = signMutableDataTombstones(tombstones, privkey_hex);

         // post them 
         return datastoreOperation(ds, 'rmdir', path, [new_parent_info['header']], [new_parent_info['idata']], [new_parent_sig], signed_tombstones);
      }
   );
}


