import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { Decimal } from 'decimal.js';
import * as dotenv from 'dotenv';

dotenv.config();

interface Trade {
  signature: string;
  type: 'buy' | 'sell';
  tokenAmount: Decimal;
  solAmount: Decimal;
  price: Decimal;
  timestamp: number;
}

interface WalletPnL {
  totalBoughtSOL: Decimal;
  totalSoldSOL: Decimal;
  realizedPnL: Decimal;
  remainingTokens: Decimal;
}

class WalletAnalyzer {
  private connection: Connection;
  private tokenMint: PublicKey;
  private wrappedSOL: PublicKey;

  constructor(rpcEndpoint: string, tokenMintAddress: string) {
    this.connection = new Connection(rpcEndpoint, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 60000
    });
    this.tokenMint = new PublicKey(tokenMintAddress);
    this.wrappedSOL = new PublicKey('So11111111111111111111111111111111111111112');
  }

  async getWalletPnL(wallet: string): Promise<WalletPnL> {
    console.log(`\nAnalyzing wallet: ${wallet}`);
    const trades = await this.getWalletTrades(wallet);
    console.log(`Found ${trades.length} trades`);

    return this.calculatePnL(trades);
  }

  private async getWalletTrades(wallet: string): Promise<Trade[]> {
    const signatures = await this.getTransactionSignatures(wallet);
    const trades: Trade[] = [];
    
    // Process in batches of 100
    const batchSize = 100;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      console.log(`Processing batch ${i/batchSize + 1}/${Math.ceil(signatures.length/batchSize)}`);
      
      const txs = await Promise.all(
        batch.map(sig => 
          this.connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0
          })
        )
      );

      txs.forEach((tx, index) => {
        if (!tx?.blockTime) return;
        const trade = this.extractTradeFromTransaction(tx, batch[index]);
        if (trade) {
          trades.push(trade);
        }
      });
    }

    return trades;
  }

  private async getTransactionSignatures(wallet: string): Promise<string[]> {
    console.log('Fetching transaction signatures...');
    const signatures: string[] = [];
    let lastSignature: string | undefined;

    while (true) {
      const options: any = {
        limit: 1000,
        before: lastSignature,
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: this.tokenMint.toBase58()
            }
          }
        ]
      };

      try {
        const txs = await this.connection.getSignaturesForAddress(
          new PublicKey(wallet),
          options
        );

        if (txs.length === 0) break;
        signatures.push(...txs.map(tx => tx.signature));
        lastSignature = txs[txs.length - 1].signature;

        console.log(`Found ${signatures.length} token-related transactions so far...`);
      } catch (error) {
        console.error('Error fetching signatures:', error);
        break;
      }
    }

    return signatures;
  }

  private extractTradeFromTransaction(tx: ParsedTransactionWithMeta, signature: string): Trade | null {
    const tokenChanges = this.getTokenChanges(tx);
    const solChanges = this.getSOLChanges(tx);

    // Find token change for the target token
    const tokenChange = tokenChanges.find(change => 
      change.mint === this.tokenMint.toBase58() && change.amount.abs().greaterThan(0)
    );

    if (!tokenChange) return null;

    // Find corresponding SOL change
    const solChange = solChanges.find(change => change.amount.abs().greaterThan(0));
    if (!solChange) return null;

    const type = tokenChange.amount.isPositive() ? 'buy' : 'sell';
    const tokenAmount = tokenChange.amount.abs();
    const solAmount = solChange.amount.abs();
    const price = solAmount.div(tokenAmount);

    return {
      signature,
      type,
      tokenAmount,
      solAmount,
      price,
      timestamp: tx.blockTime! * 1000
    };
  }

  private getTokenChanges(tx: ParsedTransactionWithMeta) {
    const changes: { mint: string; owner: string; amount: Decimal }[] = [];
    const preBalances = new Map<string, Map<string, Decimal>>();
    const postBalances = new Map<string, Map<string, Decimal>>();

    // Map pre-balances
    tx.meta?.preTokenBalances?.forEach(balance => {
      if (!balance.owner) return;
      if (!preBalances.has(balance.owner)) {
        preBalances.set(balance.owner, new Map());
      }
      preBalances.get(balance.owner)!.set(
        balance.mint,
        new Decimal(balance.uiTokenAmount.uiAmount || 0)
      );
    });

    // Map post-balances
    tx.meta?.postTokenBalances?.forEach(balance => {
      if (!balance.owner) return;
      if (!postBalances.has(balance.owner)) {
        postBalances.set(balance.owner, new Map());
      }
      postBalances.get(balance.owner)!.set(
        balance.mint,
        new Decimal(balance.uiTokenAmount.uiAmount || 0)
      );
    });

    // Calculate changes
    postBalances.forEach((balances, owner) => {
      balances.forEach((postAmount, mint) => {
        const preAmount = preBalances.get(owner)?.get(mint) || new Decimal(0);
        const change = postAmount.minus(preAmount);
        if (!change.isZero()) {
          changes.push({ mint, owner, amount: change });
        }
      });
    });

    return changes;
  }

  private getSOLChanges(tx: ParsedTransactionWithMeta) {
    const changes: { owner: string; amount: Decimal }[] = [];

    if (tx.meta?.preBalances && tx.meta?.postBalances) {
      tx.transaction?.message.accountKeys.forEach((account, index) => {
        const preSOL = new Decimal(tx.meta!.preBalances[index]).div(1e9);
        const postSOL = new Decimal(tx.meta!.postBalances[index]).div(1e9);
        const change = postSOL.minus(preSOL);
        
        if (!change.isZero()) {
          changes.push({
            owner: account.pubkey.toBase58(),
            amount: change
          });
        }
      });
    }

    return changes;
  }

  private calculatePnL(trades: Trade[]): WalletPnL {
    let totalBoughtSOL = new Decimal(0);
    let totalSoldSOL = new Decimal(0);
    let realizedPnL = new Decimal(0);
    let remainingTokens = new Decimal(0);
    
    const buyQueue: Trade[] = [];

    for (const trade of trades) {
      if (trade.type === 'buy') {
        buyQueue.push(trade);
        totalBoughtSOL = totalBoughtSOL.add(trade.solAmount);
        remainingTokens = remainingTokens.add(trade.tokenAmount);
      } else {
        let remainingSellAmount = trade.tokenAmount;
        const sellPriceSOL = trade.price;

        while (remainingSellAmount.greaterThan(0) && buyQueue.length > 0) {
          const oldestBuy = buyQueue[0];
          const buyAmount = oldestBuy.tokenAmount;
          const buyPriceSOL = oldestBuy.price;

          if (remainingSellAmount.greaterThanOrEqualTo(buyAmount)) {
            const solReceived = buyAmount.mul(sellPriceSOL);
            const solPaid = buyAmount.mul(buyPriceSOL);
            realizedPnL = realizedPnL.add(solReceived.minus(solPaid));
            remainingSellAmount = remainingSellAmount.minus(buyAmount);
            remainingTokens = remainingTokens.minus(buyAmount);
            buyQueue.shift();
          } else {
            const solReceived = remainingSellAmount.mul(sellPriceSOL);
            const solPaid = remainingSellAmount.mul(buyPriceSOL);
            realizedPnL = realizedPnL.add(solReceived.minus(solPaid));
            remainingTokens = remainingTokens.minus(remainingSellAmount);
            oldestBuy.tokenAmount = buyAmount.minus(remainingSellAmount);
            remainingSellAmount = new Decimal(0);
          }
        }

        totalSoldSOL = totalSoldSOL.add(trade.solAmount);
      }
    }

    return {
      totalBoughtSOL,
      totalSoldSOL,
      realizedPnL,
      remainingTokens
    };
  }
}

async function main() {
  const tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
  const rpcEndpoint = process.env.RPC_ENDPOINT;
  const walletAddress = '6QmaozhpTuqf8vLb3NzRNNNqNgaZLtE41r4qEvHUd8yB';

  if (!tokenMintAddress || !rpcEndpoint) {
    throw new Error('Missing environment variables');
  }

  console.log('Starting wallet analysis...');
  console.log(`Token: ${tokenMintAddress}`);
  console.log(`Wallet: ${walletAddress}`);

  const analyzer = new WalletAnalyzer(rpcEndpoint, tokenMintAddress);
  
  try {
    const pnl = await analyzer.getWalletPnL(walletAddress);
    
    console.log('\nResults:');
    console.log(`Total bought (SOL): ${pnl.totalBoughtSOL.toString()}`);
    console.log(`Total sold (SOL): ${pnl.totalSoldSOL.toString()}`);
    console.log(`Realized PnL (SOL): ${pnl.realizedPnL.toString()}`);
    console.log(`Remaining tokens: ${pnl.remainingTokens.toString()}`);
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
