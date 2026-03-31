const express = require('express');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


const CONNECTION_STRING = "DefaultEndpointsProtocol=https;AccountName=stomotoshenrique;AccountKey=n4J/lOmDf6N1ozNF/9HHcSMVWs9MFwro1j5OC3qD+t8DOjB1nxZf1ucboLj4os2CQ3p98TcU+kgI+AStPaYbDA==;EndpointSuffix=core.windows.net";



const blobClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
const containerName = "fotos-motos";
const containerClient = blobClient.getContainerClient(containerName);


const TABELA_MOTOS = "Motoss";      
const TABELA_CLIENTES = "Clientess"; 
const TABELA_PEDIDOS = "Pedidos";    

const upload = multer({ dest: 'uploads/' });

let motosTable, clientesTable, pedidosTable;


async function init() {
    try {
      
        await containerClient.createIfNotExists();
        console.log(`✅ Container "${containerName}" criado/verificado`);
        
    
        motosTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_MOTOS);
        clientesTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_CLIENTES);
        pedidosTable = TableClient.fromConnectionString(CONNECTION_STRING, TABELA_PEDIDOS);
        
    
        try {
            await motosTable.getEntity("MOTO", "teste");
        } catch (err) {
            if (err.statusCode === 404) {
                console.log(`✅ Tabela "${TABELA_MOTOS}" conectada`);
            }
        }
        
        try {
            await clientesTable.getEntity("CLIENTE", "teste");
        } catch (err) {
            if (err.statusCode === 404) {
                console.log(`✅ Tabela "${TABELA_CLIENTES}" conectada`);
            }
        }
        
        try {
            await pedidosTable.getEntity("PEDIDO", "teste");
        } catch (err) {
            if (err.statusCode === 404) {
                console.log(`✅ Tabela "${TABELA_PEDIDOS}" conectada`);
            }
        }
        
        console.log(`\n📊 Tabelas em uso:`);
        console.log(`   - ${TABELA_MOTOS} (para motos)`);
        console.log(`   - ${TABELA_CLIENTES} (para clientes)`);
        console.log(`   - ${TABELA_PEDIDOS} (para pedidos)\n`);
        
    } catch (error) {
        console.error('❌ Erro na inicialização:', error.message);
    }
}

app.get('/', async (req, res) => {
    try {
        if (!motosTable || !clientesTable) {
            return res.render('index', { motos: [], clientes: [], erro: "Inicializando..." });
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
        
        console.log(`📋 Carregados: ${motos.length} motos, ${clientes.length} clientes`);
        res.render('index', { motos, clientes, erro: null });
    } catch (err) {
        console.error('❌ Erro ao carregar:', err.message);
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
            await blockBlob.uploadFile(req.file.path);
            fotoUrl = blockBlob.url;
            fs.unlinkSync(req.file.path);
            console.log('📸 Foto enviada:', blobName);
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
        
        console.log(`✅ Moto cadastrada: ${marca} ${modelo}`);
        res.redirect('/');
    } catch (err) {
        console.error('❌ Erro ao cadastrar:', err);
        res.send(`
            <h1>Erro ao cadastrar</h1>
            <p>${err.message}</p>
            <a href="/">Voltar</a>
        `);
    }
});

app.post('/moto/excluir/:id', async (req, res) => {
    try {
        await motosTable.deleteEntity("MOTO", req.params.id);
        console.log('✅ Moto excluída');
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
        
        console.log(`✅ Cliente cadastrado: ${nome}`);
        res.redirect('/');
    } catch (err) {
        console.error('Erro:', err);
        res.send('Erro: ' + err.message);
    }
});

app.post('/cliente/excluir/:id', async (req, res) => {
    try {
        await clientesTable.deleteEntity("CLIENTE", req.params.id);
        console.log('✅ Cliente excluído');
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
            return res.send(`
                <h1>❌ Produto sem estoque!</h1>
                <a href="/">Voltar</a>
            `);
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
        
        console.log(`✅ Pedido: ${cliente.nome} comprou ${produto.marca} ${produto.modelo}`);
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Pedido Confirmado</title>
                <style>
                    body { font-family: Arial; text-align: center; padding: 50px; background: #f4f4f4; }
                    .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    h1 { color: #28a745; }
                    .detalhes { text-align: left; margin: 20px 0; padding: 15px; background: #f9f9f9; border-radius: 5px; }
                    button { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
                    button:hover { background: #0056b3; }
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
                    <button onclick="location.href='/'">Voltar para Loja</button>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        console.error('❌ Erro no checkout:', err);
        res.send(`
            <h1>Erro no checkout</h1>
            <p>${err.message}</p>
            <a href="/">Voltar</a>
        `);
    }
});

// Criar pasta uploads
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// Iniciar servidor
init().then(() => {
    app.listen(PORT, () => {
        console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
        console.log(`📦 Storage Account: stomotoshenrique`);
        console.log(`📁 Container: fotos-motos`);
        console.log(`📊 Tabelas:`);
        console.log(`   - ${TABELA_MOTOS} (para motos)`);
        console.log(`   - ${TABELA_CLIENTES} (para clientes)`);
        console.log(`   - ${TABELA_PEDIDOS} (para pedidos)`);
        console.log(`\n✨ Pronto para usar!\n`);
    });
}).catch(err => {
    console.error('❌ Falha ao iniciar:', err);
});