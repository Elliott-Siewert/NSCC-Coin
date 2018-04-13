
// set up js hint options
/* jshint node: true */
/* jshint esversion: 6 */



// strict mode
"use strict";

//imports
let CryptoJS = require("crypto-js");
let express = require("express");
let bodyParser = require("body-parser");
let WebSocket = require("ws");
let ec = require("elliptic").ec('secp256k1');
let _ = require("lodash");
let fs = require("fs");
let cluster = require('cluster');
let request = require('request');
let readFileSync = fs.readFileSync;
let existsSync = fs.existsSync;
let writeFileSync = fs.writeFileSync;

//import { readFileSync, existsSync, writeFileSync } from "fs";


// global vars
let BLOCK_GENERATION_INTERVAL = 10000;
let DIFFICULTY_ADJUSTMENT_INTERVAL = 10;
let COINBASE_AMOUNT = 50;
let MessageType = {QUERY_LATEST: 0, QUERY_ALL: 1, RESPONSE_BLOCKCHAIN: 2, QUERY_TRANSACTION_POOL: 3, RESPONSE_TRANSACTION_POOL: 4};
let http_port = process.env.HTTP_PORT || 3009;
let p2p_port = process.env.P2P_PORT || 6009;
let initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : ['ws://localhost:6002'];
let sockets = [];
let blockchain = [];
let unspentTxOuts = [];
let transactionPool = [];
let miningInterval;
//private key location
let privateKeyLocation = './private_key';
let __miningControl = true;
let nonce = 0;


//class declarations
class Block{
    constructor(index, previousHash, timestamp, data, hash, difficulty, nonce){
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.hash = hash.toString();
        this.difficulty = difficulty;
        this.nonce = nonce;
    }
}

class TxOut {
    constructor(address, amount){
        this.address = address;
        this.amount = amount;
    }
}

class TxIn {
    constructor(txOutId, txOutIndex, signature){
        this.txOutId = txOutId;
        this.txOutIndex = txOutIndex;
        this.signature = signature;
    }
}

class Transaction{
    constructor(id, txIns, txOuts){
        this.id = id;
        this.txIns = txIns;
        this.txOuts = txOuts;
    }
}

class UnspentTxOut{
    constructor(txOutId, txOutIndex, address, amount){
        this.txOutId = txOutId;
        this.txOutIndex = txOutIndex;
        this.address = address;
        this.amount = amount;
    }
}


//function declarations


//-------------------------------Wallet functions--------------------------
let getAccountBalance = () => {
    return getBalance(getPublicFromWallet(), getUnspentTxOuts());
};

let generatePrivateKey = () => {
    let keyPair = ec.genKeyPair();
    let privateKey = keyPair.getPrivate();
    return privateKey.toString(16);
};

let initWallet = () => {
    if(existsSync(privateKeyLocation)){
        return;
    }
    let newPrivateKey = generatePrivateKey();
    writeFileSync(privateKeyLocation, newPrivateKey);
    console.log("new wallet with private key created");
};

let getPublicFromWallet = () => {
    let privateKey = getPrivateFromWallet();
    let key = ec.keyFromPrivate(privateKey, 'hex');
    return key.getPublic().encode('hex');
};


let getPrivateFromWallet = () => {
    let buffer = readFileSync(privateKeyLocation, 'utf8');
    return buffer.toString();
};

let getBalance = (address, aUnspentTxOuts) => {
    return _(aUnspentTxOuts).filter((uTxo) => uTxo.address === address).map((uTxo) => uTxo.amount).sum();
};

let findTxOutsForAmount = (amount, myUnspentTxOuts) => {
    let currentAmount = 0;
    let includedUnspentTxOuts = [];
    for(let myUnspentTxOut of myUnspentTxOuts){
        includedUnspentTxOuts.push(myUnspentTxOut);
        currentAmount += myUnspentTxOut.amount;
        if(currentAmount >= amount){
            let leftOverAmount = currentAmount - amount;
            return {includedUnspentTxOuts, leftOverAmount};
        }
    }
    throw Error('not enough coins to send transaction');
};

let toUnsignedTxIn = (unspentTxOut) => {
    let txIn = new TxIn();
    txIn.txOutId = unspentTxOut.txOutId;
    txIn.txOutIndex = unspentTxOut.txOutIndex;
    return txIn;
};

let createTxOuts = (receiverAddress, myAddress, amount, leftOverAmount) => {
    let txOut1 = new TxOut(receiverAddress, amount);
    if(leftOverAmount === 0){
        return [txOut1];
    } else{
        let leftOverTx = new TxOut(myAddress, leftOverAmount);
        return [txOut1, leftOverTx];
    }
};

let createTransaction = (receiverAddress, amount, privateKey, aUnspentTxOuts) => {
    let myAddress = getPublicKey(privateKey);
    console.log(myAddress);
    let myUnspentTxOutsA = aUnspentTxOuts.filter((uTxo) => uTxo.address == myAddress);
    let myUnspentTxOuts = filterTxPoolTxs(myUnspentTxOutsA, getTransactionPool());
    let {includedUnspentTxOuts, leftOverAmount} = findTxOutsForAmount(amount, myUnspentTxOuts);
    let unsignedTxIns = includedUnspentTxOuts.map(toUnsignedTxIn);
    let tx = new Transaction();
    tx.txIns = unsignedTxIns;
    tx.txOuts = createTxOuts(receiverAddress, myAddress, amount, leftOverAmount);
    tx.id = getTransactionId(tx);

    tx.txIns = tx.txIns.map((txIn, index) => {
        txIn.signature = signTxIn(tx, index, privateKey, aUnspentTxOuts);
        return txIn;
    });
    return tx;

};

let filterTxPoolTxs = (unspentTxOuts, transactionPool) => {
    let txIns = _(transactionPool)
        .map((tx) => tx.Ins)
        .flatten()
        .value();
    let removable = [];
    for (let unspentTxOut of unspentTxOuts){
        let txIn = _.find(txIns, (aTxIn) => {
            return aTxIn.txOutIndex === unspentTxOut.txOutIndex && aTxIn.txOutId === unspentTxOut.txOutId;
        });

        if(txIn === undefined){

        } else{
            removable.push(unspentTxOut);
        }
    }
    return _.without(unspentTxOuts, ...removable);
};

//----------------------------------------Utility functions-----------------------------
let hexToBinary = (hex) => {
    let returnString = "";
    let lookupTable = {
        '0': '0000', '1': '0001', '2': '0010', '3': '0011', '4': '0100',
        '5': '0101', '6': '0110', '7': '0111', '8': '1000', '9': '1001',
        'a': '1010', 'b': '1011', 'c': '1100', 'd': '1101',
        'e': '1110', 'f': '1111'
    };
    for (let i = 0; i < hex.length; i++){
        if(lookupTable[hex[i]]){
            returnString += lookupTable[hex[i]];
        } else {
            return null;
        }
    }
    return returnString;
};

let toHexString = (byteArray) => {
    return Array.from(byteArray, (byte) =>{
        return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('');
};

//----------------------------------------Transaction functions-------------------------------
let getTransactionId = (transaction) =>{
    let txInContent = transaction.txIns
        .map((txIn) => txIn.txOutId + txIn.txOutIndex)
        .reduce((a, b) => a + b, '');
    let txOutContent = transaction.txOuts
        .map((txOut) => txOut.address + txOut.amount)
        .reduce((a, b) => a + b, '');
    return CryptoJS.SHA256(txInContent + txOutContent).toString();
};

let getPublicKey = (aPrivateKey) => {
    return ec.keyFromPrivate(aPrivateKey, 'hex').getPublic().encode('hex');
};

let signTxIn = (transaction, txInIndex, privateKey, aUnspentTxOuts) => {
    let txIn = transaction.txIns[txInIndex];
    let dataToSign = transaction.id;
    let referencedUnspentTxOut = findUnspentTxOut(txIn.txOutId, txIn.txOutIndex, aUnspentTxOuts);
    let referencedAddress = referencedUnspentTxOut.address;
    let key = ec.keyFromPrivate(privateKey, 'hex');
    let signature = toHexString(key.sign(dataToSign).toDER());
    return signature;

};

let findUnspentTxOut = (transactionId, index, aUnspentTxOuts) => {
    let foundOut = aUnspentTxOuts.find((uTxo) => uTxo.txOutId === transactionId && uTxo.txOutIndex === index);
    return foundOut;
};

let getTxInAmount = (txIn, aUnspentTxOuts) => {
    return findUnspentTxOut(txIn.txOutId, txIn.txOutIndex, aUnspentTxOuts).amount;
};

let updateUnspentTxOuts = (newTransactions, aUnspentTxOuts) => {
    //get all new unspent outputs
    let newUnspentTxOuts = newTransactions
    .map((t) =>{
        return t.txOuts.map((txOut, index) => new UnspentTxOut(t.id, index, txOut.address, txOut.amount));
    })
    .reduce((a, b) => a.concat(b), []);

    //get all consumed outputs
    let consumedTxOuts = newTransactions
        .map((t) => t.txIns)
        .reduce((a, b) => a.concat(b), [])
        .map((txIn) => new UnspentTxOut(txIn.txOutId, txIn.txOutIndex, '', 0));
    
    //take old array of unspent tx's and filter out consumed tx's then add all new tx's
    let resultingUnspentTxOuts = aUnspentTxOuts.filter(((uTxo) => !findUnspentTxOut(uTxo.txOutId, uTxo.txOutIndex, consumedTxOuts))).concat(newUnspentTxOuts);
    return resultingUnspentTxOuts;
};

let isValidTransactionStructure = (transaction) => {
    if(typeof transaction.id !== 'string'){
        console.log("transaction id missing");
        return false;
    }
    if(!(transaction.txIns instanceof Array)){
        console.log("invalid txIns");
    }
    if(!transaction.txIns.map(isValidTxInStructure).reduce((a, b) => (a && b), true)){
        console.log("at least one txIn is not valid");
        return false;
    }
    if(!(transaction.txOuts instanceof Array)){
        console.log("invalid txIns type(not array)");
        return false;
    }
    if(!transaction.txOuts.map(isValidTxOutStructure).reduce((a, b) => (a && b), true)){
        return false;
    }
    return true;
};

let isValidTransactionsStructure = (transactions) => {
    return transactions.map(isValidTransactionStructure).reduce((a, b) => (a && b), true);
};

let validateTransaction = (transaction, aUnspentTxOuts) => {
    if (getTransactionId(transaction) !== transaction.id){
        console.log("invalid tx id" + transaction.id);
        return false;
    }

    let hasValidTxIns = transaction.txIns.map((txIn) => validateTxIn(txIn, transaction, aUnspentTxOuts)).reduce((a, b) => a && b, true);
    if(!hasValidTxIns){
        console.log("some of the txIns are invalid in tx: " + transaction.id);
        return false;
    }

    let totalTxInValues = transaction.txIns.map((txIn) => getTxInAmount(txIn, aUnspentTxOuts)).reduce((a, b) => (a + b), 0);
    let totalTxOutValues = transaction.txOuts.map((txOut) => txOut.amount).reduce((a, b) => (a + b) , 0);

    for(let txOut of transaction.txOuts){
        if(txOut.amount < 0){
            console.log("trying to send nagative amount");
            return false;
        }
    }

    if(totalTxInValues !== totalTxOutValues){
        console.log("total txin amount !== total txout amount in tx: " + transaction.id);
        return false;
    }
    return true;
};

let validateTxIn = (txIn, transaction, aUnspentTxOuts) => {
    let referencedUTxOut = aUnspentTxOuts.find((uTxo) => uTxo.txOutId === txIn.txOutId && uTxo.txOutIndex === txIn.txOutIndex);
    if(referencedUTxOut == null){
        console.log(transaction);
        console.log(aUnspentTxOuts);
        console.log("referenced txOut not found: " + JSON.stringify(txIn));
        return false;
    }
    let address = referencedUTxOut.address;
    let key = ec.keyFromPublic(address, "hex");
    return key.verify(transaction.id, txIn.signature);
};

let isValidTxInStructure = (txIn) => {
    if(txIn == null){
        console.log("txin is null");
        return false;
    } else if (typeof txIn.signature !== 'string'){
        console.log("signaure of txin is invalid data type");
        return false;
    } else if (typeof txIn.txOutId !=='string'){
        console.log("invalid txOutId in txin");
        return false;
    } else if (typeof txIn.txOutIndex !== 'number'){
        console.log("invalid txOutIndex in txIn");
        return false;
    }
    return true;
};

let isValidTxOutStructure = (txOut) => {
    if(txOut == null){
        console.log("txOut is null");
        return false;
    } else if (typeof txOut.address !== 'string'){
        console.log("invalid address data type in txOut");
        return false;
    } else if (!isValidAddress(txOut.address)){
        console.log("invalid txOut address");
        return false;
    } else if (typeof txOut.amount !== 'number'){
        console.log("invalid amount type in txOut");
        return false;
    }
    return true;
};

let isValidAddress = (address) => {
    if (address.length !== 130) {
        console.log("invalid public key length");
        return false;
    } else if (address.match('^[a-fA-F0-9]+$') === null){
        console.log('public key must contain only hex characters');
        return false;
    } else if (!address.startsWith('04')){
        console.log('public ket must start with 04');
        return false;
    }
    return true;
};

let validateCoinbaseTx = (transaction, blockIndex) => {
    if(getTransactionId(transaction) !== transaction.id){
        console.log("invalid coinbase tx id: " + transaction.id);
        return false;
    }
    if(transaction.txIns.length !== 1){
        console.log("one txIn must be specified in the coinbase transaction");
        return false;
    }
    if(transaction.txIns[0].txOutIndex !== blockIndex){
        console.log("the txIn index in coinbase tx must be the block height");
        return false;
    }
    if(transaction.txOuts.length !== 1){
        console.log("invalid number os txOuts in coinbase transaction");
        return false;
    }
    if(transaction.txOuts[0].amount != COINBASE_AMOUNT){
        console.log("invalud coinbase amount in coinbase transaction");
        return false;
    }
    return true;
};

let validateBlockTransactions = (aTransactions, aUnspentTxOuts, blockIndex) => {
    let coinbaseTx = aTransactions[0];
    if(!validateCoinbaseTx(coinbaseTx, blockIndex)){
        console.log("invalid coinbase transaction");
        return false;
    }
    let txIns = _(aTransactions).map((tx) => tx.txIns).flatten().value();
    if (hasDuplicates(txIns)){
        return false;
    }
    let normalTransactions = aTransactions.slice(1);
    return normalTransactions.map((tx) => validateTransaction(tx, aUnspentTxOuts)).reduce((a, b) => (a && b), true);
};

let getCoinbaseTransaction = (address, blockIndex) => {
    let t = new Transaction();
    let txIn = new TxIn();
    txIn.signature = "";
    txIn.txOutId = "";
    txIn.txOutIndex = blockIndex;
    t.txIns = [txIn];
    t.txOuts = [new TxOut(address, COINBASE_AMOUNT)];
    t.id = getTransactionId(t);
    return t;
};

let hasDuplicates = (txIns) => {
    console.log(txIns);
    let groups = _.countBy(txIns, (txIn) => txIn.txOutId + txIn.txOutId);
    return _(groups).map((value, key) => {
        if (value > 1){
            console.log("duplicate txIn");
            return true;
        } else{
            return false;
        }
    }).includes(true);
};

let processTransactions = (aTransactions, aUnspentTxOuts, blockIndex) => {
    if(!isValidTransactionsStructure(aTransactions)){
        return null;
    }
    if(!validateBlockTransactions(aTransactions, aUnspentTxOuts, blockIndex)){
        return null;
    }
    return updateUnspentTxOuts(aTransactions, aUnspentTxOuts);
};

let sendTransaction = (address, amount) => {
    let tx = createTransaction(address, amount, getPrivateFromWallet(), getUnspentTxOuts(), getTransactionPool());
    addToTransactionPool(tx, getUnspentTxOuts());
    return tx;
};

let isValidTxForPool = (tx, aTransactionPool) => {
    let txPoolIns = getTxPoolIns(aTransactionPool);
    for(let txIn of tx.txIns){
        if(containsTxIn(txPoolIns, txIn)){
            console.log("txIn already found in the txPool");
            return false;
        }
    }
    broadCastTransactionPool();
    return true;
};

let containsTxIn = (txPoolIns, txIn) => {
    return _.find(txPoolIns, (txPoolIn => {
        return txIn.txOutIndex === txPoolIn.txOutIndex && txIn.txOutId === txPoolIn.txOutId;
    }));
};

let updateTransactionPool = (unspentTxOuts) => {
    let invalidTxs = [];
    for(let tx of transactionPool){
        for(let txIn of tx.txIns){
            if(!hasTxIn(txIn, unspentTxOuts)){
                invalidTxs.push(tx);
                break;
            }
        }
    }
    if(invalidTxs.length > 0){
        console.log('removing the following transactions from txPool: %s', JSON.stringify(invalidTxs));
        transactionPool = _.without(transactionPool, ...invalidTxs);
    }
};

let hasTxIn = (txIn, unspentTxOuts) => {
    let foindTxIn = unspentTxOuts.find((uTxo) => {
        return uTxo.txOutId === txIn.txOutId && uTxo.txOutIndex === txIn.txOutIndex;
    });
};

let getTransactionPool = () => {
    return _.cloneDeep(transactionPool);
};

let addToTransactionPool = (tx, unspentTxOuts)  => {
    if(!validateTransaction(tx, unspentTxOuts)){
        throw Error('Tying to add invalid tx to pool');
    }

    if(!isValidTxForPool(tx, transactionPool)){
        throw Error('Trying to add invalid tx to pool');
    }
    console.log('adding to txPool: %s', JSON.stringify(tx));
    transactionPool.push(tx);
    //broadCastTransactionPool();
};

let getTxPoolIns = (aTransactionPool) => {
    return _(aTransactionPool).map((tx) => tx.txIns).flatten().value();
};

let getUnspentTxOuts = () => {
    return _.cloneDeep(unspentTxOuts);
};

let handleReceivedTransaction = (transaction) => {
    addToTransactionPool(transaction, getUnspentTxOuts());
};

//------------------------------------Blockchain functions------------------------------------
let calculateHash = (index, previousHash, timestamp, data, difficulty, nonce) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + data + difficulty + nonce).toString();
};

let calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.difficulty, block.nonce);
};

let hashMatchesDifficulty = (hash, difficulty) => {
    let hashinBinary = hexToBinary(hash);
    let requiredPrefix = "0".repeat(difficulty);
    return hashinBinary.startsWith(requiredPrefix);
};

let getDifficulty = (aBlockchain) =>{
    let latestBlock = aBlockchain[aBlockchain.length - 1];
    if(latestBlock.index % DIFFICULTY_ADJUSTMENT_INTERVAL === 0 && latestBlock.index !== 0){
        return getAdjustedDifficulty(latestBlock, aBlockchain);
    } else{
        return latestBlock.difficulty;
    }
};

let getAdjustedDifficulty = (latestBlock, aBlockchain) => {
    let prevAdjustmentBlock = aBlockchain[blockchain.length - DIFFICULTY_ADJUSTMENT_INTERVAL];
    let timeExpected = BLOCK_GENERATION_INTERVAL * DIFFICULTY_ADJUSTMENT_INTERVAL;
    let timeTaken = latestBlock.timestamp - prevAdjustmentBlock.timestamp;
    if(timeTaken < timeExpected / 2){
        return prevAdjustmentBlock.difficulty + 1;
    } else if (timeTaken > timeExpected * 2){
        return prevAdjustmentBlock.difficulty - 1;
    } else{
        return prevAdjustmentBlock.difficulty;
    }
};

let isValidTimestamp = (newBlock, previousBlock) => {
    return (previousBlock.timestamp - 60000 < newBlock.timestamp) && (newBlock.timestamp - 60000 < new Date().getTime());
};

let findBlock = (index, previousHash, data, difficulty) =>{
    for(let i = 0; i < 10000; i++){
        //console.log("nonce" + nonce);
        var timestamp = new Date().getTime();
        let hash = calculateHash(index, previousHash, timestamp, data, difficulty, nonce);
        if(hashMatchesDifficulty(hash, difficulty)){
            return new Block(index, previousHash, timestamp, data, hash, difficulty, nonce);
        }
        nonce++;
    }
    return null;
};

// let findBlock = (index, previousHash, data, difficulty) =>{
//     let nonce = 0;
//     while(true){
//         var timestamp = new Date().getTime();
//         let hash = calculateHash(index, previousHash, timestamp, data, difficulty, nonce);
//         if(hashMatchesDifficulty(hash, difficulty)){
//             return new Block(index, previousHash, timestamp, data, hash, difficulty, nonce);
//         }
//         nonce++;
//     }
// };

let generateRawNextBlock = (blockData) => {
    let previousBlock = getLatestBlock();
    let nextIndex = previousBlock.index + 1;
    let newBlock = findBlock(nextIndex, previousBlock.hash, blockData, getDifficulty(blockchain));
    if(newBlock !== null){
        if(addBlock(newBlock)){
            console.log("found block!");
            nonce = 0;
            broadcast(responseLatestMsg());
            return newBlock;
        } else{
            return null;
        }
    }
    
};

let generateNextBlock = () => {
    let coinbaseTx = getCoinbaseTransaction(getPublicFromWallet(), getLatestBlock().index + 1);
    let blockData = [coinbaseTx].concat(getTransactionPool());
    return generateRawNextBlock(blockData);
};
    
let generateNextBlockLoop = () => {
    //console.log("__miningControl: " + __miningControl);
    if(__miningControl){
        __miningControl = false;
        //console.log("mingingBlock");
        generateNextBlock();
        __miningControl = true; 
    }   
    //console.log(nonce);
    return;
};


var getGenesisBlock = () => {
    let genBlockIndex = 0;
    let genBlockPrevHash = "0";
    let genBlockTime = 1523472578.904;
    let genBlockData = "Elliott's genesis block";
    let genBlockDif = 0;
    let genNonce = 0;
    let genHash = calculateHash();
    return new Block(genBlockIndex, genBlockPrevHash, genBlockTime, genBlockData, genHash, genBlockDif, genNonce);
};

let addBlock = (newBlock) => {
    if (isValidNewBlock(newBlock, getLatestBlock())){
        let newUnspentTxOuts = processTransactions(newBlock.data, getUnspentTxOuts(), newBlock.index);
        if (newUnspentTxOuts === null){
            return false;
        } else{
            blockchain.push(newBlock);
            // console.log(newUnspentTxOuts);
            unspentTxOuts = newUnspentTxOuts;
            updateTransactionPool(unspentTxOuts);
            return true;
        }

        
    }
    return false;
};


var isValidNewBlock = (newBlock, previousBlock) => {
    if(previousBlock.index + 1 !== newBlock.index){
        console.log('invalid index');
        return false;
    } else if(previousBlock.hash !== newBlock.previousHash){
        console.log('invalid previoushash ' + previousBlock.hash +  " : " + newBlock.previousHash);
        return false;
    } else if(calculateHashForBlock(newBlock) !== newBlock.hash){
        //console.log("invalid hash " + calculateHashForBlock(newBlock) + " : " + newBlock.hash.toString());
        return false;
    }
    return true;
};

var replaceChain = (newBlocks) => {
    let aUnspentTxOuts = isValidChain(newBlocks);
    let validChain = aUnspentTxOuts !== null;
    if(validChain && getAccumulatedDifficulty(newBlocks) > getAccumulatedDifficulty(getBlockchain())){
        console.log("received blockchain is valid");
        blockchain = newBlocks;
        nonce = 0;
        setUnspentTxOuts(aUnspentTxOuts);
        updateTransactionPool(unspentTxOuts);
        broadcast(responseLatestMsg());
    }else{
        console.log("received blockchain invalid");
    }
};

var isValidChain = (blockChainToValidate) => {
    if(!isValidGenesis(blockChainToValidate[0])){
        return null;
    }
    let tempUnspentTxOuts = [];
    for(let i = 0; i < blockChainToValidate.length; i++){
        let currentBlock = blockChainToValidate[i];
        if(i !== 0 && !isValidNewBlock(currentBlock, blockChainToValidate[i-1])){
            console.log("invalid block while validating new chain");
            return null;
        }
        if(i !==0){
            tempUnspentTxOuts = processTransactions(currentBlock.data, tempUnspentTxOuts, currentBlock.index);
        }
        if(tempUnspentTxOuts === null){
            console.log("invalid transactions in block while validating new chain")
            return null;
        }
              
    }
    return tempUnspentTxOuts;  
    // if (JSON.stringify(blockChainToValidate[0]) !== JSON.stringify(getGenesisBlock())){
    //     return false;
    // }
    // let tempBlocks = [blockChainToValidate[0]];
    // for (let i = 1; i < blockChainToValidate.length; i++){
    //     if(isValidNewBlock(blockChainToValidate[i], tempBlocks[i - 1])){
    //         tempBlocks.push(blockChainToValidate[i]);
    //     } else{
    //         return false;
    //     }
    // }
    // return true;
};

let isValidGenesis = (block) => {
    return JSON.stringify(block) === JSON.stringify(getGenesisBlock());
};

let getLatestBlock = () => blockchain[blockchain.length - 1];

let getAccumulatedDifficulty = (aBlockchain) => {
    return aBlockchain.map((block) => block.difficulty).map((difficulty) => Math.pow(2, difficulty)).reduce((a, b) => a+b);
};

let setUnspentTxOuts = (newUnspentTxOuts) => {
    unspentTxOuts = newUnspentTxOuts;
};

let getBlockchain = () => {
    return blockchain;
};

//----------------------------servers functions--------------------------

// initialize http server
var initHttpServer = () => {
    var app = express();
    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
    app.get('/unspentTransactionOutputs', (req, res) =>{
        res.send(getUnspentTxOuts());
    });
    app.get('/myUnspentTransactionOutputs', (req, res) => {
        res.send(getMyUnspentTransactionOutputs());
    });
    app.get('/balance', (req, res) => {
        let balance = getAccountBalance();
        res.send({'balance': balance});
    });
    app.get('/address', (req, res) => {
        res.send({'address': getPublicFromWallet()});
    });
    app.post('/mineBlock', (req, res) => {
        console.log("received request to mine block");
        var newBlock = generateNextBlock();
        if (newBlock === null){
            res.status(400).send("could not generate block");
        } else{
            res.send(newBlock);
        }
    });
    app.post('/mineChain', (req, res) => {
        console.log("received request to mine chain");
        console.log(__miningControl);
        // __miningControl = true;
        // if(!__miningControl){
        //     cluster.fork();
        //     __miningControl = true;
        // }
        __miningControl = true;
        miningInterval = setInterval(generateNextBlockLoop, 1);
        res.send();
    });
    // app.post('/mineChain', (req, res) => {
    //     console.log("received request to mine chain");
    //     if(!__miningControl){
    //         __miningControl = true;
    //         cluster.fork();
    //     }
        
    //     res.send();
    // });    
    
    app.post('/stopMiningChain', (req, res) => {
        console.log("received request to stop mining chain");
        __miningControl = false;
        clearInterval(miningInterval);
        res.send();
    });
    app.get('/__miningControl', (req, res) => {
        res.send();
    });
    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.renotePort));
    });
    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });
    app.post('/mineTransaction', (req, res) => {
        let address = req.body.address;
        let amount = req.body.amount;
        let resp = generatenextBlockWithTransaction(address, amount);
        res.send(resp);
    });
    app.post('/sendTransaction' , (req, res) => {
        try{
            let address = req.body.address;
            let amount = req.body.amount;
            if (address === undefined || amount === undefined){
                throw Error('invalid address or amount');
            }
            let resp = sendTransaction(address, amount);
            broadCastTransactionPool();
            res.send(resp);
        } catch (e) {
            console.log(e.message);
            res.status(400).send(e.message);
        }
    });
    app.get('/transactionPool', (req, res) => {
        res.send(getTransactionPool());
    });
    app.listen(http_port, () => console.log('Listening on port: ' + http_port));
};

//initialize p2p server
let initP2PServer = () => {
    let server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log("listening websocket p2p port on: " + p2p_port);
};

let initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
    setTimeout(() => {
        broadcast(queryTransactionPoolMsg());
    }, 500);
};

let initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        let message = JSON.parse(data);
        console.log("received message: " + JSON.stringify(message));
        switch (message.type){
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockChainResponse(message);
                break;
            case MessageType.QUERY_TRANSACTION_POOL:
                write(ws, responseTransactionPoolMsg());
                break;
            case MessageType.RESPONSE_TRANSACTION_POOL:
                let receivedTransactions = JSON.parse(message.data);
                if (receivedTransactions === null){
                    console.log("invalid transaction received: %s", JSON.stringify(message.data));
                }
                receivedTransactions.forEach((transaction) => {
                    try{
                        handleReceivedTransaction(transaction);
                        //broadCastTransactionPool();
                    } catch(e){
                        console.log(e.message);
                    }
                });
                break;
        }
    });
};

let initErrorHandler = (ws) => {
    let closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

let connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        console.log(peer);
        let ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () =>{
            console.log("Connection to peer failed");
        });
        ws.on('close', (e) =>{
            console.log(e);
        });
    });
};

let handleBlockChainResponse = (message) => {
    let receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    let latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    let latestBlockHeld = getLatestBlock();
    if(latestBlockReceived.index > latestBlockHeld.index){
        console.log("blockchain possibly behind");
        if(latestBlockHeld.hash === latestBlockReceived.previousHash){
            console.log("We can append the received block to our chain");
            addBlock(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1){
            console.log("need to query chain from peers");
            broadcast(queryAllMsg());
        } else{
            console.log("Received blockchain is longer than current blockchain attempting to replace");
            replaceChain(receivedBlocks);
        }
    } else{
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

let queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
let queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
let responseChainMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});

let responseLatestMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify([getLatestBlock()])
});

let responseTransactionPoolMsg = () => ({
    'type': MessageType.RESPONSE_TRANSACTION_POOL,
    'data': JSON.stringify(getTransactionPool())
});

let queryTransactionPoolMsg = () => ({
    'type': MessageType.QUERY_TRANSACTION_POOL,
    'data': null
});

let broadCastTransactionPool = () => {
    broadcast(responseTransactionPoolMsg());
};

let write = (ws, message) => ws.send(JSON.stringify(message));
let broadcast = (message) => {
    console.log("broadcasting: " + JSON.stringify(message));
    sockets.forEach(socket => write(socket, message));
};

let miner = () => {
    console.log("in miner");
    connectToPeers(['ws://localhost:6002']);
    generateNextBlock();
    process.exit();
};

//main function
let main = function(){
    if(!cluster.isMaster){
        p2p_port++;
        http_port++;
    } else{
        cluster.on('death', ()=> {
            __miningControl = false;
        });
    }
    console.log("initializing");
    console.log("building genesis block");
    blockchain.push(getGenesisBlock());
    console.log("connectingToPeers");
    connectToPeers(initialPeers);
    console.log("initializing http server");
    initHttpServer();
    console.log("initializing p2p server");
    initP2PServer();
    console.log("loading wallet");
    initWallet();
    miningInterval = setInterval(generateNextBlockLoop, 10);
    if(!cluster.isMaster){
        miner();
    } 
};



//run program
main();