#!/usr/bin/env node
 
/**
 * Module dependencies.
 */
 
var program = require('commander');
var util = require('util');
var _ = require('underscore');
var us = require('underscore.string');
var request = require('request');
var fs = require('fs');
var jsonic = require('jsonic');
var Rsync = require('rsync');
var os = require('os');
var npm = require('npm');
var url = require('url');
var path = require('path');
var yaml = require('yamljs');
var Chance = require('chance');
var chance = new Chance();
var camelcase = require('camelcase');
var querystring = require('querystring');
/*
 * ENV
 */
var SCOPE = '@shaharsol';
//var SCOPE = '@commandcar';

var APIS_DIR = path.join(__dirname,'node_modules',SCOPE);
//console.log('api dir: ' + APIS_DIR);
/*
 * make sure we have a USE dir
 */

var USE_DIR = path.join(os.tmpdir(),'commandcar-use');
//console.log('use dir: ' + USE_DIR);
try{
	fs.mkdirSync(USE_DIR);
}catch(e){
	// ignore. it means it already exists
}

/*
 * load database
 */

var database = loadDatabaseFromCache();
if(!database){
	console.log('couldnt find cache, building database');
	database = buildDatabaseFromFileSystem();
}




_.each(database,function(apiContent,api){
	console.log('processing commands for ' + api);
	var commandName;
	_.each(apiContent.paths,function(pathContent,path){
		var parts = path.split('/');
		var includedParts = [];
		_.each(parts,function(part){
			if(part && !us(part).startsWith('{') && !us(part).endsWith('}')){
				includedParts.push(part);
			}
		});
		var rejoinedParts = includedParts.join('_').replace('-','_');
		_.each(pathContent,function(verbContent,verb){
			commandName = api + '.' + verb + '_' +  rejoinedParts;
			var shorts = [];
			console.log('found command: ' + commandName);
			var theCommand = program.command(commandName);
			
			// always start with the api key in order to keep its short name persistent over all the api methods
			if('security' in verbContent){
				var apiKey = _.find(verbContent.security,function(item){
					return 'api_key' in item;
				})
				if(apiKey){
					var short = getShort(apiContent.securityDefinitions.api_key.name,shorts);
					shorts.push(short);
					theCommand.option('-' + short + ', --' + apiContent.securityDefinitions.api_key.name + ' <' + apiContent.securityDefinitions.api_key.name + '>',apiContent.securityDefinitions.api_key.name);
				}
			}
			
			
			_.each(verbContent.parameters,function(parameter){
				var short = getShort(parameter.name,shorts);
				shorts.push(short);
				
				var leftTag = ' [';
				var rightTag = ']';
				if(parameter.required){
					leftTag = ' <';
					rightTag = '>';
				}
				
				theCommand.option('-' + short + ', --' + parameter.name + leftTag + parameter.name + rightTag,parameter.description);
			});
			// TBD
			/*
			 * 
			 * also, add use and unuse with this particular key!
			 */
			
			theCommand.action(function(options,o1,o2){
				performRequest(api,path,verb,options,function(err,ret){
					if(err){
						console.log('error: ' + err);
					}else{
						console.log(ret);
					}
				});
			})
			
		})
	});
	
	
})

program
	.command('load')
	.option('-l, --location [location of directory]','location of directory')
	.action(function(options){
		console.log('loading ' + options.location);
		var rsync = new Rsync()
					.flags('avz')
					.source(options.location)
					.destination(APIS_DIR);
		rsync.execute(function(error, code, cmd) {
		    if(error){
		    	console.log(code + ' : ' + error);
		    }else{
		    	database = buildDatabaseFromFileSystem();
		    }
		});
	});

program
	.command('install')
	.option('-a, --api [api name]','api name')
	.action(function(options){
		console.log('installing ' + SCOPE + "/" + options.api);
		npm.load(function (err) {
			if(err){
				console.log('error installing from npm: ' + err);
			}else{
				npm.commands.install(__dirname,[SCOPE + "/" + options.api], function (er, data) {
					if(er){
						console.log('npm error: ' + er);
					}
					database = buildDatabaseFromFileSystem();
				});
				npm.on("log", function (message) {
					console.log(message);
				});
				
			}
		});

	});



//program
//	.command('facebook_get')
//	.option('-u, --uid [user id]','facebook user id')
//	.action(function(options){
//		console.log('should call facebook with uid ' + options.uid)
//	});
//
//program
//	.command('dropbox_get')
//	.option('-u, --uid [user id]','dropbox user id')
//	.action(function(options){
//		console.log('should call dropbox with uid ' + options.uid)
//	});

//console.log('prigram: ' + util.inspect(program));

program.parse(process.argv);

function performCommand(api,path,verb,options,callback){
	switch(command){
	case 'use':
		use(api,options,callback);
		break;
	case 'unuse':
		unuse(api,callback);
		break;
	default:
		performRequest(api,path,verb,options,callback);
	}
}

function use(api,options,callback){
	try{
		var currentApi = _.find(database,function(item){return item.name == api;});
		var useOptions = {};
		_.each(currentApi.use_options,function(useOption){
			useOptions[useOption.long] = options[useOption.long];
		});
		fs.writeFileSync(path.join(USE_DIR,api + '.json'),JSON.stringify(useOptions));
		callback(null);
	}catch(e){
		callback(e);
	}
}

function unuse(api,callback){
	try{
		fs.unlinkSync(path.join(USE_DIR,api + '.json'));
		callback(null);
	}catch(e){
		callback(e);
	}
}

function performRequest(api,path,verb,options,callback){
	
	
	// is the host known? or is passed as -h --host?
	// facebook host is known: graph.facebook.com
	// gradle host is always param: 192.8.9.10
	
	// some api take authorization bearer as headers
	// some allow auth to pass as params
	// some require basic auth
	var theUrl;
	var form;
	var pathStr = '';
	
	// TBD add port (i.e. default 80 but surely not always)
	// TBD consider passing the entire api and command objects, and not only thier names, 
	// hence not having to find them...
	
//	try{
//		useOptions = jsonic(fs.readFileSync(path.join(USE_DIR,api + '.json'), 'utf8'));
//		_.each(useOptions,function(value,key){
//			options[key] = value;
//		})
//	}catch(e){
//		
//	}
	
	
	
	
	var protocol = database[api].schemes[0];
	console.log('protocil: ' + protocol);
	var host = database[api].host;
	console.log('host: ' + host);

	
	
//	theUrl = currentApi.protocol + '://' + currentApi.hostname;
	pathStr = database[api].basePath + path
	console.log('pathStr: ' + pathStr);

	var pathParts = pathStr.split('/');
	var newParts = [];
	_.each(pathParts,function(pathPart){
		if(us(pathPart).startsWith('{') && us(pathPart).endsWith('}')){
			console.log('found a param');
			console.log('param name: ' + pathPart.substr(1,pathPart.length-2));
			console.log('cameld case: ' + normalizeParameterName(pathPart.substr(1,pathPart.length-2)));
			console.log('param value: ' + options[normalizeParameterName(pathPart.substr(1,pathPart.length-2))]);
			pathPart = options[normalizeParameterName(pathPart.substr(1,pathPart.length-2))];
		}
		newParts.push(pathPart);
	});
	pathStr = newParts.join('/');
	console.log('pathStr: ' + pathStr);
	
//	console.log(util.inspect(options));
	var query = {};
//	console.log('options: ' + util.inspect(options));
	_.each(database[api].paths[path][verb].parameters,function(parameter){
		console.log('parameter name: ' + parameter.name);
		console.log('parameter name cameled: ' + normalizeParameterName(parameter.name));
		console.log('parameter value: ' + options[normalizeParameterName(parameter.name)]);
		
		if(parameter['in'] == 'query'){
			query[parameter.name] = options[normalizeParameterName(parameter.name)];
		}
	}); 
	
	// do we have to add security params to query?
	if('security' in database[api].paths[path][verb]){
		var apiKey = _.find(database[api].paths[path][verb].security,function(item){
			return 'api_key' in item;
		})
		console.log('api def: ' + util.inspect(database[api].securityDefinitions.api_key))
		if(database[api].securityDefinitions.api_key['in'] == 'query'){
			query[database[api].securityDefinitions.api_key.name] = options[normalizeParameterName(database[api].securityDefinitions.api_key.name)]
		}
	}
	
	var queryString = querystring.stringify(query);
	
console.log('querystring: ' + queryString);
	
	var urlObj = {
		protocol: protocol,
		host: host,
		pathname: pathStr,
		query: query
	}
	// TBD: dont forget basic auth!
	
	theUrl = url.format(urlObj);
	console.log('url: ' + theUrl);
		
	var headers = {};
	var form = {};
	
	var requestOptions = {
		url: theUrl,
		method: verb.toUpperCase(),
		headers: headers,
	}
	
	if(!_.isEmpty(form)){
		requestOptions['form'] = form;
	}
	
//	console.log('requestOptions: ' + util.inspect(requestOptions));
	
	request(requestOptions,function(error,response,body){
		if(error){
			callback(error);
		}else if(response.statusCode < 200 || response.statusCode > 299){
//			console.log('status code: ' + response.statusCode);
			callback(body);
		}else{
			console.log('body is: ' + util.inspect(body));
			var ret;
			if('ret' in currentCommand){
				var data = JSON.parse(body);
				ret = data[currentCommand['ret']];
			}else{
				ret = body;
			}
			var data = JSON.parse(body);
			callback(null,ret);
		}
	})
	
}

// TBD: need to work with the path module to make it compatible with windows???
function buildDatabaseFromFileSystem(){
	var database = {};
	var api;
//	var files = fs.readdirSync(__dirname + '/apis/');
	try{
		if(fs.lstatSync(APIS_DIR).isDirectory()){
			var files = fs.readdirSync(APIS_DIR);
			_.each(files,function(file){
				
				// now i expect file to be a yaml file
				console.log('found file: ' + file);
				console.log('extname is: ' + path.extname(file));
				
				if(path.extname(file) == '.yaml'){
					console.log('found a yaml!');
					var apiName = path.basename(file,'.yaml');
					database[apiName] = yaml.load(path.join(APIS_DIR,file));
				}
				
				
			});
		}else{
			console.log('APIS_DIR doesnt seem to be a directory...');
		}	
	}catch(e){
		console.log('error building db: ' + e);
	}
	
//	console.log('database: ' + util.inspect(database,{depth:8}));
	fs.writeFileSync(path.join(os.tmpdir(),'commandcar-cache.json'),JSON.stringify(database));
	return database;
}

function loadDatabaseFromCache(){
	var cache = null;
	try{
		console.log('reading cache from: ' + path.join(os.tmpdir(),'commandcar-cache.json'));
		cache = fs.readFileSync(path.join(os.tmpdir(),'commandcar-cache.json'), 'utf-8');
		cache = jsonic(cache);
	}catch(e){
		
	}
	return cache;
}

function getShort(name,shorts){
	var test = name.charAt(0).toLowerCase();
	if(_.contains(shorts,test)){
		test = name.charAt(0).toUpperCase();
		if(_.contains(shorts,test)){
			test = name.charAt(name.length -1).toLowerCase();
			if(_.contains(shorts,test)){
				test = name.charAt(name.length -1).toUpperCase();
				if(_.contains(shorts,test)){
					test = chance.character({pool:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'});
					while(_.contains(shorts,test)){
						test = chance.character({pool:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'});
					}
				}
			}
		}
	}
	return test;
}

function normalizeParameterName(name){
	var parts = name.split('-');
	var newParts = [];
	newParts.push(parts[0]);
	for(var i=1;i<parts.length;i++){
		newParts.push(parts[i].charAt(0).toUpperCase() + parts[i].slice(1));
	}
	return newParts.join('');
}