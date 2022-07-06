let lastPollTime = Date.now();
let lastBlockHeight = 0;
let etherscanAPIIntervalRateCount = 0;
let etherscanAPIIntervalRateLimitPerSecond = 5;

let scanERC721FreeMint = [];
let scanERC721FreeMintTransactions = [];
let scanERC721FreeMintTransactionTransfers = [];
let trendingERC721FreeMintMatches = [];

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

				// For tracking the total number of matching transfers in the transaction
				// Over `maxTransfersPerTransaction` will be ignored
				let transferMatchCount = 0;
	
				transaction.logs.forEach(log => {
					if (
						// First param should be keckak256() of `Transfer` event
						log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
		
						// From null 0x0
						&& log.topics[1] === '0x0000000000000000000000000000000000000000000000000000000000000000'
		
						// Data is empty
						&& log.data === '0x'
					) {
						// console.log('Matching `Transfer` event signature; with `0x` log data');
						// console.log('topics[1] is 0x0 address');
		
						const recipientByte32 = padToBytes32(transaction.from.address);
						// console.log('recipientByte32: ' + recipientByte32);
						if (log.topics[2] === recipientByte32) {
							// console.log('Pattern match: `ERC721FreeMint`');
							// console.log('Contract: ' + transaction.to.address);
							// console.log('topics[2] is sender address');
		
							const suspectedTokenId = decodeX(log.topics[3], "uint256");
							// console.log(log.topics[3]);
							// console.log('suspectedTokenId: ' + suspectedTokenId);

							// The token ID is under `maxTransferTokenIdValue`
							if (suspectedTokenId < maxTransferTokenIdValue) {
								transferMatchCount++;
							}
						}
					}
				});

				// Ignore transactions with more than `maxTransfersPerTransaction` transfers
				if (transferMatchCount && transferMatchCount <= maxTransfersPerTransaction) {
					const existsWithId = scanERC721FreeMint.findIndex(address => address === transaction.to.address);
					if (existsWithId < 0) {

						// Lookup contract ABI
						let contractABIRaw = getContractABI(transaction.to.address);
						if (
							!contractABIRaw

							// Avoid API abuse
							&& etherscanAPIIntervalRateCount < etherscanAPIIntervalRateLimitPerSecond
						) {
							contractABIRaw = requestContractABI(transaction.to.address);
							etherscanAPIIntervalRateCount++;
						}

						// Check `inputData` against ABI, for function name patterns (i.e. contains `mint`)
						if (contractABIRaw) {
							let contractABI;
							try {
								contractABI = JSON.parse(contractABIRaw);
							} catch (err) {
								console.error('ABI parse error: ' + transaction.to.address);
								console.error(err);
							}
							if (contractABI) {
								// console.log('inputData: ' + transaction.inputData);
								const contractInterface = new ethers.utils.Interface(contractABI);
								if (contractInterface) {
									let result = contractInterface.parseTransaction({data: transaction.inputData});
									// console.log(result);

									let functionName = result.name.toLowerCase();
									console.log('functionName: ' + functionName);

									const functionBlacklistResult = functionNameBlacklistPattern.findIndex(a => {
										const test = functionName.indexOf(a)
										return test >= 0
									});
									// console.log('functionBlacklistResult: ' + functionBlacklistResult);
									if (functionBlacklistResult < 0) {
										const functionWhitelistResult = functionNameWhitelistPattern.findIndex(a => {
											const test = functionName.indexOf(a)
											return test >= 0
										});
										// console.log('functionWhitelistResult: ' + functionWhitelistResult);
										if (functionWhitelistResult >= 0) {
											scanERC721FreeMintTransactions[scanERC721FreeMint.length] = 1;
											scanERC721FreeMintTransactionTransfers[scanERC721FreeMint.length] = transferMatchCount;

											scanERC721FreeMint.push(transaction.to.address);
											console.log('Matched: ' + transaction.to.address);
										}
									}
								} else {
									console.error('ABI parse error (ethers.js): ' + transaction.to.address);
								}
							}
						} else {
							console.error('ABI lookup failed: ' + transaction.to.address);
						}
					} else {
						scanERC721FreeMintTransactions[existsWithId]++;
						scanERC721FreeMintTransactionTransfers[existsWithId] += transferMatchCount;
					}
				}
			}
		});
	}

	// Aggregate dataset, after every `intervalProcessMilliseconds` since `lastPollTime`
	let sinceLastPollTime = (Date.now() - lastPollTime);
	if (sinceLastPollTime > intervalProcessMilliseconds) {

		// Process dataset
		if (scanERC721FreeMint.length) {

			console.log('Pattern match: `ERC721FreeMint`');
			console.log('-'.repeat(80));

			// Sort matches in descending order
			let scanERC721FreeMintTransactionsDescending = [...scanERC721FreeMintTransactions];
			scanERC721FreeMintTransactionsDescending.sort((a, b) => {
				let a1 = typeof a, b1 = typeof b;
				return (a1 < b1 ? 1 : (a1 > b1 ? -1 : (a < b ? 1 : (a > b ? -1 : 0))));
			});

			let scanERC721FreeMintTransactionsRef = [...scanERC721FreeMintTransactions];
			
			// Walk through the descending matches, for the correct index
			for (let i = 0; i < scanERC721FreeMintTransactionsDescending.length; i++) {
				let findValue = scanERC721FreeMintTransactionsDescending[i];
				let result = scanERC721FreeMintTransactionsRef.findIndex(a => a === findValue);

				// Empty the found index, to prevent cases where there are different matches, of the same count.
				if (result >= 0) {
					trendingERC721FreeMintMatches.push(result);
					scanERC721FreeMintTransactionsRef[result] = 0;
				}

				// Max result limit reached
				if (trendingERC721FreeMintMatches.length == maxTrendingResults)
					break;
			}

			// Raw results as they were found
			// scanERC721FreeMint.forEach((address, idx) => {
			// 	console.log(`Result: ${idx} / Occurances: ${scanERC721FreeMintTransactions[idx]} / Contract: ${address}`);
			// 	// console.log('-'.repeat(80));
			// 	// console.log(`${URI_BLOCK_EXPLORER_ADDRESS}${address}#transactions`);
			// 	console.log('-'.repeat(80));
			// });
			// console.log('-'.repeat(80));

			// Payload for Discord API
			let discordPayload = {
				embeds: []
			};

			trendingERC721FreeMintMatches.forEach(idx => {
				const contractHistoryExists = contractHistory.findIndex(a => a === scanERC721FreeMint[idx]);
				// console.log('contractHistoryExists: ' + contractHistoryExists);
				if (contractHistoryExists < 0) {
					contractHistory.push(scanERC721FreeMint[idx]);

					console.log(`R: ${idx} / TX: ${scanERC721FreeMintTransactions[idx]} / Tfers: ${scanERC721FreeMintTransactionTransfers[idx]} / Addr: ${scanERC721FreeMint[idx]}`);
					// console.log('-'.repeat(80));
					// console.log(`${URI_BLOCK_EXPLORER_ADDRESS}${scanERC721FreeMint[idx]}#transactions`);
					console.log('-'.repeat(80));

					discordPayload.embeds.push({
						title: scanERC721FreeMint[idx],
						description: `Transactions: ${scanERC721FreeMintTransactions[idx]} / Transfers: ${scanERC721FreeMintTransactionTransfers[idx]}`,
						url: `${URI_BLOCK_EXPLORER_ADDRESS}${scanERC721FreeMint[idx]}`,
						// TODO: Opensea API - collection lookup needed
						// image: {
						// 	url: ''
						// }
					});
				}
			});

			// TODO: Opensea API for collection deets?
			
			// POST payload to Discord
			if (discordPayload.length) {
				axios
				.post(DISCORD_API_ENDPOINT, discordPayload)
				.then(res => {
					console.log(`statusCode: ${res.status}`);
					console.log(res);
				})
				.catch(error => {
					console.error(error);
				});

				console.log(JSON.stringify(discordPayload));
				console.info('Announced new contracts: ' + discordPayload.length);
			} else {
				console.info('No new contracts to announce');
			}

			// Persist current contract history
			putContractHistory(JSON.stringify(contractHistory));

			// Clear dataset for next run
			scanERC721FreeMint = [];
			scanERC721FreeMintTransactions = [];
			scanERC721FreeMintTransactionTransfers = [];
			trendingERC721FreeMintMatches = [];
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