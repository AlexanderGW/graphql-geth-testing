require('dotenv').config()

const { ethers } = require("ethers");
const { request } = require("graphql-request");

const padToBytes32 = (x) => {
	return ethers.utils.hexlify(
		ethers.utils.zeroPad("0x" + x.replace("0x", ""), 32)
	);
};

const decodeX = (x, t) => ethers.utils.defaultAbiCoder.decode([t], x)[0];

const URI_BLOCK_EXPLORER_ADDRESS = process.env.URI_BLOCK_EXPLORER_ADDRESS;

const GETH_GRAPHQL_ENDPOINT = process.env.GETH_GRAPHQL_ENDPOINT;

let scanERC721FreeMint = [];
let scanERC721FreeMintOccurances = [];

const main = async () => {
	const resp = await request(
		GETH_GRAPHQL_ENDPOINT,
		`{block {
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
						if (suspectedTokenId < 10000) {

							// TODO: Check `inputData` against ABI, for function name checks (i.e. contais `mint`)

							const existsWithId = scanERC721FreeMint.findIndex(address => address === transaction.to.address);
							if (existsWithId < 0) {
								scanERC721FreeMintOccurances[scanERC721FreeMint.length] = 1;
								scanERC721FreeMint.push(transaction.to.address);
							} else {
								scanERC721FreeMintOccurances[existsWithId]++;
							}
								
						}
					}
				}
			});
		}
	});

	console.log('Pattern match: `scanERC721FreeMint`');
	console.log('-'.repeat(120));
	// console.log(scanERC721FreeMint);
	if (scanERC721FreeMint.length) {
		scanERC721FreeMint.forEach((address, idx) => {
			console.log(`Result: ${idx} / Occurances: ${scanERC721FreeMintOccurances[idx]} / Contract: ${address}`);
			console.log('-'.repeat(120));
			console.log(`${URI_BLOCK_EXPLORER_ADDRESS}${address}#transactions`);
			console.log('-'.repeat(120));
		});
	} else {
		console.info('No matches found.');
	}
};

main();