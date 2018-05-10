import cryptojs from "crypto-js"
import express from "express"
import bodyParser from "body-parser"
import WebSocket from "ws"

let { HTTP_PORT = 3001, P2P_PORT = 6001, PEERS = '' as any } = process.env

PEERS = PEERS.split(',').filter(Boolean)

const str = JSON.stringify

class Block {
    constructor(
        public index: number,
        public prevHash: string,
        public timestamp: number,
        public data: string,
        public hash: string
    ) {}
}

const first = new Block(
    0,
    '0',
    1465154705,
    'the first block',
    cryptojs.SHA256('001465154705the first block').toString()
)


class BlockChain {
    static Chain : Block[] = [first]

    get lastBlock() {
        return BlockChain.Chain[BlockChain.Chain.length - 1]
    }

    get firstBlock(){
        return first
    }

    createNewBlock(data: string): Block{
        const index = this.lastBlock.index + 1
        const timestamp = new Date().getTime() / 1000
        const hash = this.getHash(index, this.lastBlock.hash, timestamp, data)
        return new Block(index, this.lastBlock.hash, timestamp, data, hash)
    }

    getHash(index: number, hash: string, timestamp: number, data: string): string;
    getHash(index: Block): string;
    getHash(index: any): string {
        if (index instanceof Block) {
            const block = index
            return this.getHash(block.index, block.prevHash, block.timestamp, block.data)
        }
        return (cryptojs.SHA256 as any)(...Array.from(arguments)).toString()
    }

    createNewBlockAndPush(data: string): Block {
        const block = this.createNewBlock(data)
        this.push(block)
        return block
    }

    push(block: Block) {
        if(this.checkNewBlock(block, this.lastBlock)){
            BlockChain.Chain.push(block)
        }
    }

    checkNewBlock(current: Block, prev: Block) : boolean {
        return [
            prev.index + 1 === current.index,
            prev.hash === current.prevHash,
            this.getHash(current) === current.hash
        ].some(Boolean)
    }

    checkChain(blocks: Block[]) {
        if(str(blocks[0]) !== str(first)) {
            return false
        }
        return blocks.some((current, index) => {
            if (index == 0) {
                return true
            }
            if (this.checkNewBlock(current, blocks[index - 1])) {
                return true
            }
            return false
        })
    }

    replaceChain(blocks: Block[]) {
        if(this.checkChain(blocks) && blocks.length > BlockChain.Chain.length){
            console.log("接受到有效的区块链")
            BlockChain.Chain = blocks
            
        }else {
            console.log("无效的区块链");
            
        }
    }
}

class Server {
    static QUERY_LASTEST = 0
    static QUERY_ALL = 1
    static RESPONSE_BLOCKCHAIN = 2
    app: express.Express = null as any
    wss: WebSocket.Server = null as any
    sockets: any[] = []

    constructor(private chain: BlockChain) {        
    }

    initWeb(){
        const app = express()
        this.app = app
        app.use(bodyParser.json())
        this.addRoute()
        app.listen(HTTP_PORT, () => {
            console.log(`服务已经在 ${HTTP_PORT} 端口启动了`);
        })
    }

    addRoute(){
        const { app, chain } = this
        app.get('/blocks', (req, res) => res.send(str(BlockChain.Chain)))
        app.post('/mimeBlock', (req, res) => {
            const block = this.chain.createNewBlockAndPush(req.body.data)
            this.broadcase({
                type: Server.RESPONSE_BLOCKCHAIN,
                data: str([chain.lastBlock])
            })
            console.log(`新加入了一个区块 ${str(block)}`);
            console.log("广播，告诉大家区块链更新了");
            res.send()
        })
        app.get('/peers', (req, res) => {
            res.send(
                this.sockets.map( s => s._socket.remoteAddress + ':' + s._socket.remotePort)
            )
        })
        app.post('/addPeer', (req, res) => {
            this.connectToPeers([req.body.peer])
            res.send()
        })
    }
    connectToPeers(peers: string[]) {
        peers.forEach(peer => {
            const ws = new WebSocket(peer)
            ws.on('open', () => {
                this.newLink(ws)
            })
            ws.on('error', e => {
                console.log(e)
            })
        })
    }

    newLink(socket: WebSocket) {
        this.sockets.push(socket)
        this.handleMessage(socket)
        this.handleError(socket)
        this.write(socket, this.queryChainLengthMsg)
    }

    initWSS() {
        const wss = new WebSocket.Server({port: P2P_PORT} as any)
        this.wss = wss
        this.wss.on('connection', socket => this.newLink(socket))
    }

    get queryChainLengthMsg(){
        return { type: Server.QUERY_LASTEST }
    }

    get queryAllMsg(){
        return { type: Server.QUERY_ALL }
    }

    get responseChainMsg() {
        return { type: Server.RESPONSE_BLOCKCHAIN, data: str(BlockChain.Chain) }
    }

    get responseLatestMsg(){
        return { type: Server.RESPONSE_BLOCKCHAIN, data: str([this.chain.lastBlock]) }
    }

    write(socket: WebSocket, msg: any) {
        socket.send(str(msg))
    }

    broadcase(msg: object) {
        this.sockets.forEach(s => this.write(s, msg))
    }

    handleMessage(socket: WebSocket) {
        socket.on('message', (data: string) => {
            const msg = JSON.parse(data)
            switch (msg.type) {
                case Server.QUERY_LASTEST:
                    this.write(socket, {
                        type: Server.RESPONSE_BLOCKCHAIN,
                        data: str([this.chain.lastBlock])
                    })
                    break;
                case Server.QUERY_ALL:
                    this.write(socket, {
                        type: Server.RESPONSE_BLOCKCHAIN,
                        data: str(BlockChain.Chain)
                    })
                    break;
                case Server.RESPONSE_BLOCKCHAIN:
                    this.handleBlockChain(msg.data)
                    break;
            }
        })
    }

    handleBlockChain(blocks: string) {
        const sortedBlockChain = JSON.parse(blocks).sort((b1: Block, b2: Block) => b1.index - b2.index)

        console.log(`接受到区块链 ${str(sortedBlockChain)}`);

        const lastBlockFromReceived: Block = sortedBlockChain[sortedBlockChain.length - 1]

        if (lastBlockFromReceived.index > this.chain.lastBlock.index) {
            console.log(`接受到新的区块，本机最新序号为 ${this.chain.lastBlock.index}， 接受到的序号为 ${lastBlockFromReceived.index}`);
            if (lastBlockFromReceived.prevHash === this.chain.lastBlock.hash) {
                console.log("新接受的区块，刚好对接到末尾");
                this.chain.push(lastBlockFromReceived)
                this.broadcase(this.responseLatestMsg)
            }else if (sortedBlockChain.length === 1) {
                console.log(`有区块新添加了节点，查询一下`);
                this.broadcase(this.queryAllMsg)
            } else {
                console.log(`接受到新的区块链，但是比当前的更长，需要检测并替换`);
                this.chain.replaceChain(sortedBlockChain)
                this.broadcase(this.responseChainMsg)
            }
        } else {
            console.log(`接受到一个已存在的区块，啥也不干。`);
            
        }

        
    }

    handleError(socket: WebSocket) {
        const closeConnection = (socket: WebSocket) => {
            console.log(`${socket.url} 断开了连接`);
            this.sockets.splice(this.sockets.indexOf(socket), 1)
        }
        socket.on('close', () => closeConnection(socket))
        socket.on('error', () => closeConnection(socket))
    }

}

const chain = new BlockChain()
const server = new Server(chain)
server.initWeb()
server.initWSS()
server.connectToPeers(PEERS)