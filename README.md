# Geth node GraphQL testing
Playing around with simple pattern matching concepts via the Geth GraphQL interface, for possible future Ethereum bots.

## scanERC721FreeMint.js
Scans latest block for transactions which match basic `Transfer` event, and other ERC-721 patterns within logs

## trendingNFTFreeMint.js
Watches blocks consecutively (every `INTERVAL_CHECK_MILLISECONDS`) for transactions which match various transfer events, and other ERC-721 and ERC-1155 patterns within transaction logs.
Will post to Discord endpoint (every `INTERVAL_PROCESS_MILLISECONDS`) assuming the contract hasn't been previously witnessed.

### TODO
Announce based on transaction trend changes every `INTERVAL_PROCESS_MILLISECONDS`