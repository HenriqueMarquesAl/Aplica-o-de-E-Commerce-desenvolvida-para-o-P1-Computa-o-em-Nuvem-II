const express = require('express');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CONNECTION_STRING = process.env.CONNECTION_STRING;

const blobClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
const containerName = "fotos-motos";
const containerClient = blobClient.getContainerClient(containerName);

const TABELA_MOTOS = "Motoss";
const TABELA_CLIENTES = "Clientess";
const TABELA_PEDIDOS = "Pedidos";

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

let motosTable, clientesTable, pedidosTable;

async function init() {
    try {
        await containerClient.createIfNotExists();
        motosTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_MOTOS);
        clientesTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_CLIENTES);
        pedidosTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_PEDIDOS);
        console.log('Azure conectado');
    } catch (error) {
        console.error('Erro:', error.message);
    }
}

app.get('/', async (req, res) => {
    try {
        if (!motosTable || !clientesTable) {
            return res.status(500).send('Inicializando, aguarde...');
        }
        
        const motos = [];
        const motosIterator = motosTable.listEntities();
        for await (const moto of motosIterator) {
            motos.push(moto);
        }
        
        const clientes = [];
        const clientesIterator = clientesTable.listEntities();
        for await (const cliente of clientesIterator) {
            clientes.push(cliente);
        }
        
        res.render('index', { motos, clientes, erro: null });
    } catch (err) {
        res.render('index', { motos: [], clientes: [], erro: err.message });
    }
});

app.post('/moto', upload.single('foto'), async (req, res) => {
    try {
        const { marca, modelo, valor, quantidade } = req.body;
        let fotoUrl = '';
        
        if (req.file) {
            const blobName = `${uuidv4()}-${req.file.originalname}`;
            const blockBlob = containerClient.getBlockBlobClient(blobName);
            await blockBlob.uploadData(req.file.buffer);
            fotoUrl = blockBlob.url;
        }
        
        await motosTable.createEntity({
            partitionKey: "MOTO",
            rowKey: uuidv4(),
            marca, modelo,
            valor: parseFloat(valor),
            quantidade: parseInt(quantidade),
            fotoUrl,
            dataCadastro: new Date().toISOString()
        });
        
        res.redirect('/');
    } catch (err) {
        res.send(`Erro: ${err.message}`);
    }
});

app.post('/moto/excluir/:id', async (req, res) => {
    try {
        await motosTable.deleteEntity("MOTO", req.params.id);
        res.redirect('/');
    } catch (err) {
        res.send('Erro: ' + err.message);
    }
});

app.post('/cliente', async (req, res) => {
    try {
        const { nome, email, telefone } = req.body;
        
        await clientesTable.createEntity({
            partitionKey: "CLIENTE",
            rowKey: uuidv4(),
            nome, email,
            telefone: telefone || '',
            dataCadastro: new Date().toISOString(),
            historico: "[]"
        });
        
        res.redirect('/');
    } catch (err) {
        res.send('Erro: ' + err.message);
    }
});

app.post('/cliente/excluir/:id', async (req, res) => {
    try {
        await clientesTable.deleteEntity("CLIENTE", req.params.id);
        res.redirect('/');
    } catch (err) {
        res.send('Erro: ' + err.message);
    }
});

app.post('/checkout', async (req, res) => {
    const { produtoId, clienteId, pagamento, entrega } = req.body;
    
    try {
        const produto = await motosTable.getEntity("MOTO", produtoId);
        const cliente = await clientesTable.getEntity("CLIENTE", clienteId);
        
        if (produto.quantidade <= 0) {
            return res.send(`<h1>❌ Sem estoque</h1><a href="/">Voltar</a>`);
        }
        
        produto.quantidade--;
        await motosTable.updateEntity(produto);
        
        const pedido = {
            partitionKey: "PEDIDO",
            rowKey: uuidv4(),
            produtoId, clienteId,
            produtoNome: `${produto.marca} ${produto.modelo}`,
            clienteNome: cliente.nome,
            valor: produto.valor,
            pagamento, entrega,
            data: new Date().toISOString(),
            status: "Confirmado"
        };
        
        await pedidosTable.createEntity(pedido);
        
        const historico = JSON.parse(cliente.historico || '[]');
        historico.push({
            produto: `${produto.marca} ${produto.modelo}`,
            valor: produto.valor,
            data: new Date().toISOString(),
            pedidoId: pedido.rowKey
        });
        cliente.historico = JSON.stringify(historico);
        await clientesTable.updateEntity(cliente);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Pedido Confirmado</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; background: #f4f4f4; }
                    .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: auto; }
                    h1 { color: #28a745; }
                    .detalhes { text-align: left; margin: 20px 0; padding: 15px; background: #f9f9f9; border-radius: 5px; }
                    button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>✅ Pedido Realizado!</h1>
                    <div class="detalhes">
                        <p><strong>Cliente:</strong> ${cliente.nome}</p>
                        <p><strong>Produto:</strong> ${produto.marca} ${produto.modelo}</p>
                        <p><strong>Valor:</strong> R$ ${produto.valor.toFixed(2)}</p>
                        <p><strong>Pagamento:</strong> ${pagamento}</p>
                        <p><strong>Entrega:</strong> ${entrega}</p>
                    </div>
                    <button onclick="location.href='/'">Voltar</button>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.send('Erro: ' + err.message);
    }
});

init().then(() => {
    if (process.env.VERCEL) {
        module.exports = app;
    } else {
        app.listen(PORT, () => {
            console.log(`Servidor em http://localhost:${PORT}`);
        });
    }
});