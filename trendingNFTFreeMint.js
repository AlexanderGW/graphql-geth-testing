let lastPollTime = Date.now();
let lastBlockHeight = 0;
let etherscanAPIIntervalRateCount = 0;
let etherscanAPIIntervalRateLimitPerSecond = 5;

let scanNFTFreeMint = [];
let scanNFTFreeMintTransactions = [];
let scanNFTFreeMintTransactionTransfers = [];
let trendingNFTFreeMintMatches = [];

let contractLookup = [[],[]];
let contractHistory = [];

require('dotenv').config()

const fs = require('fs');
const axios = require('axios');
const { ethers } = require('ethers');
const { SingleFieldSubscriptionsRule } = require('graphql');
const { request } = require('graphql-request');

let intervalCheckMilliseconds = process.env.INTERVAL_CHECK_MILLISECONDS;
let intervalProcessMilliseconds = process.env.INTERVAL_PROCESS_MILLISECONDS;
let maxTrendingResults = process.env.MAX_TRENDING_RESULTS;
let maxTransfersPerTransaction = process.env.MAX_TRANSFERS_PER_TRANSACTION;
let maxTransferTokenIdValue = process.env.MAX_TRANSFER_TOKEN_ID_VALUE;

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const URI_BLOCK_EXPLORER_ADDRESS = process.env.URI_BLOCK_EXPLORER_ADDRESS;
const GETH_GRAPHQL_ENDPOINT = process.env.GETH_GRAPHQL_ENDPOINT;
const DISCORD_API_ENDPOINT = process.env.DISCORD_API_ENDPOINT;

const functionNameWhitelistPattern = [
	'mint', 'public'
];

const functionNameBlacklistPattern = [
	'private', 'whitelist'
];

const functionParameterBlacklistPattern = [
	'sign', 'root', 'proof', 'whitelist'
];

const padToBytes32 = (x) => {
	return ethers.utils.hexlify(
		ethers.utils.zeroPad("0x" + x.replace("0x", ""), 32)
	);
};

const decodeX = (x, t) => ethers.utils.defaultAbiCoder.decode([t], x)[0];

const getFile = (_path) => {
	try {
		const content = fs.readFileSync(_path, 'utf8');
		return content;
	} catch (err) {
		// console.error(err);
		return false;
	}
};

const getContractHistory = () => {
	let path = `./.cache/contract-history.json`;
	return getFile(path);
};

const getContractABI = (_address) => {
	let path = `./.cache/abi/${_address}.json`;
	return getFile(path);
};

const putFile = (_path, _data) => {
	fs.writeFile(_path, _data, function (err, data) {
		if (err) {
			console.log(err);
			return false;
		}
		// console.log(data);
	});
};

const putContractABI = async (_address, _data) => {
	let path = `./.cache/abi/${_address}.json`;
	return putFile(path, _data);
};

const putContractHistory = (_data) => {
	let path = `./.cache/contract-history.json`;
	return putFile(path, _data);
};

const requestContractABI = (_address) => {
	// console.log(`https://api.etherscan.io/api?module=contract&action=getabi&address=${_address}&apikey=${ETHERSCAN_API_KEY}`);
	axios
		.get(
			`https://api.etherscan.io/api?module=contract&action=getabi&address=${_address}&apikey=${ETHERSCAN_API_KEY}`
		)
		.then(res => {
			// console.log(`statusCode: ${res.status}`);
			// console.log(res.data);
			putContractABI(_address, res.data.result);
			return res.data.result;
		})
		.catch(error => {
			// console.error(error);
			return false;
		});
};

const getContract = (_address) => {

	// Look for cache from previous contract lookup
	const contractLookupResult = contractLookup[0].findIndex(a => a === _address);
	if (contractLookupResult >= 0) {
		return contractLookup[1][contractLookupResult];
	}

	let contractABIRaw, contractABI, contractInterface;

	let contract = {
		abiRaw: null,
		abi: null,
		interface: null,
	};

	// Lookup contract ABI
	contractABIRaw = getContractABI(_address);
	if (
		!contractABIRaw

		// Avoid API abuse
		&& etherscanAPIIntervalRateCount < etherscanAPIIntervalRateLimitPerSecond
	) {
		contractABIRaw = requestContractABI(_address);
		etherscanAPIIntervalRateCount++;
	}

	// Check `inputData` against ABI, for function name patterns (i.e. contains `mint`)
	if (contractABIRaw) {
		contract.abiRaw = contractABIRaw;

		try {
			contractABI = JSON.parse(contractABIRaw);
		} catch (err) {
			console.error('ABI parse error: ' + _address);
			console.error(err);
		}
		if (contractABI) {
			contract.abi = contractABI;
			
			// console.log('inputData: ' + transaction.inputData);
			contractInterface = new ethers.utils.Interface(contractABI);
			if (contractInterface) {
				contract.interface = contractInterface;
			} else {
				console.error('ABI parse error (ethers.js): ' + _address);
			}
		}
	} else {
		console.error('ABI lookup failed: ' + _address);
	}

	// Cache results for future contract requests
	const contractPos = contractLookup[0].length;
	contractLookup[0][contractPos] = _address;
	contractLookup[1][contractPos] = contract;

	return contract;
};

const main = async () => {
	let resp = await request(
		GETH_GRAPHQL_ENDPOINT,
		`{block {
			number
		}}`
	);

	// Block height changed, scan all transactions for pattern
	let currentBlockHeight = parseInt(resp.block.number);
	if (currentBlockHeight > lastBlockHeight) {
		lastBlockHeight = currentBlockHeight;

		let workingBlockHeight = lastBlockHeight - 1;

		resp = await request(
			GETH_GRAPHQL_ENDPOINT,
			`{block(number: ${workingBlockHeight}) {
				number,
				timestamp,
				transactions {
					hash,
					from {
						address
					},
					to {
						address
					},
					value,
					inputData,
					logs {
						index,
						topics,
						data
					}
				}
			}}`
		);
	
		// console.log(resp.block);
		console.log('Scanning block: ' + resp.block.number);
	
		// return;
	
		resp.block.transactions.forEach(transaction => {
			const isFreeMint = transaction.value === '0x0';
			// console.log('Is a free mint? ' + isFreeMint);
			if (isFreeMint) {
				// console.log('Is a free mint? ' + isFreeMint);

				let skipTransaction = true;

				// For tracking the total number of matching transfers in the transaction
				// Over `maxTransfersPerTransaction` will be ignored
				let transferMatchCount = 0;
	
				transaction.logs.forEach(log => {

					// ERC-721
					if (

						// First param should be keckak256() of `Transfer(address,address,uint256)` event
						log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
		
						// From null 0x0
						&& log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000'
		
						// Data is empty
						&& log.data === '0x'
					) {
						const recipientByte32 = padToBytes32(transaction.from.address);
						// console.log('recipientByte32: ' + recipientByte32);
						if (
							recipientByte32 !== '0x000000000000000000000000000000000000000000000000000000000000dead'
							&& log.topics[2] === recipientByte32
						) {
		
							const suspectedTokenId = decodeX(log.topics[3], "uint256");
							// console.log(log.topics[3]);
							// console.log('ERC-721 suspectedTokenId: ' + suspectedTokenId);

							// The token ID is under `maxTransferTokenIdValue`
							if (suspectedTokenId < maxTransferTokenIdValue)
								skipTransaction = false;
							
							transferMatchCount++;
						}
					}
					
					// ERC-1155 - TransferSingle
					else if (
						// First param should be keckak256() of `TransferSingle(address,address,address,uint256,uint256)` event
						log.topics[0] === '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62'

						// From null 0x0
						&& log.topics[2] === '0x0000000000000000000000000000000000000000000000000000000000000000'
					) {
		
						const recipientByte32 = padToBytes32(transaction.from.address);
						// console.log('recipientByte32: ' + recipientByte32);
						if (
							recipientByte32 !== '0x000000000000000000000000000000000000000000000000000000000000dead'
							&& log.topics[1] === recipientByte32
							&& log.topics[3] === recipientByte32
						) {
		
							// console.log('ERC-1155 ('+transaction.to.address+') TransferSingle suspectedTokenId:');
							const contract = getContract(transaction.to.address);
							if (contract.interface) {
								try {
									const result = contract.interface.parseLog(log);
									if (result.args) {
										let suspectedTokenId = 0;
										try {
											suspectedTokenId = result.args[3].toNumber()
										} catch (err) {
											console.error(`Invalid TransferSingle parameter 'id' value. Skip...`);
											console.error(err);
										}
										if (

											// The token ID is under `maxTransferTokenIdValue` 
											suspectedTokenId && suspectedTokenId < maxTransferTokenIdValue

											// Value is always 1 (unique NFT)
											&& result.args[4].toNumber() === 1
										) {
											skipTransaction = false;
										}
									}
								} catch (err) {
									console.error(`parseLog failed`);
									console.error(err);
									console.info(contract.interface.parseLog(log));
								}
							}

							transferMatchCount++;
						}
					}

					// ERC-1155 - TransferBatch
					else if (
						// First param should be keckak256() of `TransferBatch(address,address,address,uint256[],uint256[])` event
						log.topics[0] === '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb'

						// From null 0x0
						&& log.topics[2] === '0x0000000000000000000000000000000000000000000000000000000000000000'
					) {
		
						const recipientByte32 = padToBytes32(transaction.from.address);
						// console.log('recipientByte32: ' + recipientByte32);
						if (
							recipientByte32 !== '0x000000000000000000000000000000000000000000000000000000000000dead'
							&& log.topics[1] === recipientByte32
							&& log.topics[3] === recipientByte32
						) {
		
							// console.log('ERC-1155 TransferBatch: '+transaction.to.address+')');
							// console.log('ERC-1155 TransferBatch: '+transaction.hash+')');
							// console.log(log.topics);
							// console.log(log.data);

							// Lookup contract
							const contract = getContract(transaction.to.address);
							if (contract.interface) {
								const result = contract.interface.parseLog(log);
								// console.log(result);
								if (result.args) {
									let score = 0;

									// The token ID is under `maxTransferTokenIdValue`
									result.args[3].forEach(id => {
										// console.log('id: ' + id);
										if (id.toNumber() < maxTransferTokenIdValue)
											score++;
									});

									// Value is always 1 (unique NFT)
									result.args[4].forEach(value => {
										// console.log('value: ' + value);
										if (value.toNumber() === 1)
											score++;
									});

									// console.log('score: ' + score);

									// Require equal scores across `id` and `value`
									if (score > 1 && score % 2 === 0)
										skipTransaction = false;
								}
							} else {
								console.error('Failed to interface contract: ' + transaction.to.address);
							}
							// const suspectedTokenId = decodeX(log.topics[4], "uint256");
							// console.log(suspectedTokenId);

							// The token ID is under `maxTransferTokenIdValue`
							// if (suspectedTokenId < maxTransferTokenIdValue) {
							// 	transferMatchCount++;
							// }

							transferMatchCount++;
						}
					}
				});

				// Ignore transactions with more than `maxTransfersPerTransaction` transfers
				if (
					!skipTransaction
					&& transferMatchCount
					&& transferMatchCount <= maxTransfersPerTransaction
				) {
					let existsWithId = false;

					try {
						existsWithId = 
							scanNFTFreeMint
							.findIndex(
								address =>
									address === transaction.to.address
							);
					} catch (err) {
						console.error(`Something wrong with transaction?`);
						console.error(err);
						console.log(transaction);
					}

					if (existsWithId < 0) {

						// Lookup contract
						const contract = getContract(transaction.to.address);
						if (contract.interface) {
							let result = contract.interface.parseTransaction({data: transaction.inputData});
							// console.log(result);

							// Input data is a function
							// console.log(result.functionFragment);
							if (result.functionFragment.type === 'function') {
								let functionName = result.name.toLowerCase();
								console.log('Function name: ' + functionName);

								const functionBlacklistResult =
									functionNameBlacklistPattern
									.findIndex(
										pattern =>
											functionName.indexOf(pattern) >= 0
									);
								// console.log('functionBlacklistResult: ' + functionBlacklistResult);
								if (functionBlacklistResult < 0) {
									const functionWhitelistResult =
										functionNameWhitelistPattern
										.findIndex(
											pattern =>
												functionName.indexOf(pattern) >= 0
										);
									// console.log('functionWhitelistResult: ' + functionWhitelistResult);
									if (functionWhitelistResult >= 0) {
										
										// Check function parameters for blacklist patterns
										let paramFlags = 0;
										for (const paramIdx in result.functionFragment.inputs) {
											// console.log(result.functionFragment.inputs[paramIdx].name);
											const functionParameterBlacklistResult =
												functionParameterBlacklistPattern
												.findIndex(
													pattern =>
														result.functionFragment.inputs[paramIdx].name.indexOf(pattern) >= 0
												);
											
											// Increase flag count if a match
											if (functionParameterBlacklistResult >= 0)
												paramFlags++;
										};

										// console.log(paramFlags);
										if (!paramFlags) {
											scanNFTFreeMintTransactions[scanNFTFreeMint.length] = 1;
											scanNFTFreeMintTransactionTransfers[scanNFTFreeMint.length] = transferMatchCount;

											scanNFTFreeMint.push(transaction.to.address);
											console.log('Matched: ' + transaction.to.address);
										}
									}
								}
							}
						} else {
							console.error('ABI parse error (ethers.js): ' + transaction.to.address);
						}
						
					} else {
						scanNFTFreeMintTransactions[existsWithId]++;
						scanNFTFreeMintTransactionTransfers[existsWithId] += transferMatchCount;
					}
				}
			}
		});
	}

	// Aggregate dataset, after every `intervalProcessMilliseconds` since `lastPollTime`
	let sinceLastPollTime = (Date.now() - lastPollTime);
	if (sinceLastPollTime > intervalProcessMilliseconds) {

		// Process dataset
		if (scanNFTFreeMint.length) {

			console.log('Pattern match: `NFTFreeMint`');
			console.log('-'.repeat(80));

			// Sort matches in descending order
			let scanNFTFreeMintTransactionsDescending = [...scanNFTFreeMintTransactions];
			scanNFTFreeMintTransactionsDescending.sort((a, b) => {
				let a1 = typeof a, b1 = typeof b;
				return (a1 < b1 ? 1 : (a1 > b1 ? -1 : (a < b ? 1 : (a > b ? -1 : 0))));
			});

			let scanNFTFreeMintTransactionsRef = [...scanNFTFreeMintTransactions];
			
			// Walk through the descending matches, for the correct index
			for (let i = 0; i < scanNFTFreeMintTransactionsDescending.length; i++) {
				let findValue = scanNFTFreeMintTransactionsDescending[i];
				let result = scanNFTFreeMintTransactionsRef.findIndex(a => a === findValue);

				// Empty the found index, to prevent cases where there are different matches, of the same count.
				if (result >= 0) {
					trendingNFTFreeMintMatches.push(result);
					scanNFTFreeMintTransactionsRef[result] = 0;
				}

				// Max result limit reached
				if (trendingNFTFreeMintMatches.length == maxTrendingResults)
					break;
			}

			// Raw results as they were found
			// scanNFTFreeMint.forEach((address, idx) => {
			// 	console.log(`Result: ${idx} / Occurances: ${scanNFTFreeMintTransactions[idx]} / Contract: ${address}`);
			// 	// console.log('-'.repeat(80));
			// 	// console.log(`${URI_BLOCK_EXPLORER_ADDRESS}${address}#transactions`);
			// 	console.log('-'.repeat(80));
			// });
			// console.log('-'.repeat(80));

			// Payload for Discord API
			let discordPayload = {
				embeds: []
			};

			trendingNFTFreeMintMatches.forEach(idx => {
				const contractHistoryExists = contractHistory.findIndex(a => a === scanNFTFreeMint[idx]);
				// console.log('contractHistoryExists: ' + contractHistoryExists);
				if (contractHistoryExists < 0) {
					contractHistory.push(scanNFTFreeMint[idx]);

					console.log(`R: ${idx} / TX: ${scanNFTFreeMintTransactions[idx]} / Tfers: ${scanNFTFreeMintTransactionTransfers[idx]} / Addr: ${scanNFTFreeMint[idx]}`);
					// console.log('-'.repeat(80));
					// console.log(`${URI_BLOCK_EXPLORER_ADDRESS}${scanNFTFreeMint[idx]}#transactions`);
					console.log('-'.repeat(80));

					discordPayload.embeds.push({
						title: scanNFTFreeMint[idx],
						description: `Transactions: ${scanNFTFreeMintTransactions[idx]} / Transfers: ${scanNFTFreeMintTransactionTransfers[idx]}`,
						url: `${URI_BLOCK_EXPLORER_ADDRESS}${scanNFTFreeMint[idx]}`,
						// TODO: Opensea API - collection lookup needed
						// image: {
						// 	url: ''
						// }
					});
				}
			});

			// TODO: Opensea API for collection deets?
			
			// POST payload to Discord
			if (discordPayload.embeds.length) {
				axios
				.post(DISCORD_API_ENDPOINT, discordPayload)
				.then(res => {
					// console.log(`statusCode: ${res.status}`);
					// console.log(res);
					console.info('Announced new contracts: ' + discordPayload.embeds.length);
				})
				.catch(error => {
					console.error(error);
					console.error('Attempted to announce new contracts: ' + discordPayload.embeds.length);
					console.error(discordPayload);
				});

				// console.log(JSON.stringify(discordPayload));
			} else {
				console.info('No new contracts to announce');
			}

			// Persist current contract history
			putContractHistory(JSON.stringify(contractHistory));

			// Clear dataset for next run
			scanNFTFreeMint = [];
			scanNFTFreeMintTransactions = [];
			scanNFTFreeMintTransactionTransfers = [];
			trendingNFTFreeMintMatches = [];
		} else {
			console.warn('No results within polling window');
		}

		// Set last run
		lastPollTime = Date.now();
		// console.log(lastPollTime);
	}

	// Reset API rate limit
	etherscanAPIIntervalRateCount = 0;
};

main();
setInterval(() => {
	main();
}, intervalCheckMilliseconds);

// let hash = '0x4cc79cb508817c0dde321e9578d748d643574676ae9353ad9d2f342a1cada4dc';

// let resp = request(
// 	GETH_GRAPHQL_ENDPOINT,
// 	`{transaction(hash: "${hash}") {
// 		hash,
// 		from {
// 			address
// 		},
// 		to {
// 			address
// 		},
// 		value,
// 		inputData,
// 		logs {
// 			index,
// 			topics,
// 			data
// 		}
// 	}}`
// ).then(res => {
// 	// console.log(res.transaction);
// 	res.transaction.logs.forEach(log => {
// 		const contract = getContract(res.transaction.to.address);
// 		if (contract.interface) {
// 			let result = contract.interface.parseTransaction({data: res.transaction.inputData});
// 			console.log(result);
// 			if (result.functionFragment.type === 'function') {
// 				let flags = 0;
// 				for (const paramIdx in result.functionFragment.inputs) {
// 					// console.log(result.functionFragment.inputs[paramIdx].name);
// 					const functionParameterBlacklistResult =
// 						functionParameterBlacklistPattern
// 						.findIndex(
// 							pattern =>
// 								result.functionFragment.inputs[paramIdx].name.indexOf(pattern) >= 0
// 						)
// 					if (functionParameterBlacklistResult >= 0)
// 						flags++;
// 				};
// 	console.log(flags);
// 				if (!flags)
// 					transferMatchCount++;
// 			}
// 		}
// 	});
// }).catch(err => {
// 	console.log(err);
// });





