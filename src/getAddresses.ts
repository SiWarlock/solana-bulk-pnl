import { Connection, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

class TokenAddressCollector {
  private connection: Connection;
  private tokenMint: PublicKey;

  constructor(rpcEndpoint: string, tokenMintAddress: string) {
    this.connection = new Connection(rpcEndpoint, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 60000
    });
    this.tokenMint = new PublicKey(tokenMintAddress);
  }

  async getAllAddresses(): Promise<Set<string>> {
    console.log('Fetching all token-related signatures...');
    const signatures = await this.getTokenTransactionSignatures();
    console.log(`Found ${signatures.length} total transactions`);

    const addresses = new Set<string>();
    const batchSize = 100;

    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(signatures.length/batchSize)}`);

      const txs = await Promise.all(
        batch.map(sig => 
          this.connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0
          })
        )
      );

      txs.forEach(tx => {
        if (!tx?.meta?.preTokenBalances || !tx.meta?.postTokenBalances) return;

        // Get addresses from pre-balances
        tx.meta.preTokenBalances.forEach(balance => {
          if (balance.mint === this.tokenMint.toBase58() && balance.owner) {
            addresses.add(balance.owner);
          }
        });

        // Get addresses from post-balances
        tx.meta.postTokenBalances.forEach(balance => {
          if (balance.mint === this.tokenMint.toBase58() && balance.owner) {
            addresses.add(balance.owner);
          }
        });
      });
    }

    return addresses;
  }

  private async getTokenTransactionSignatures(): Promise<string[]> {
    const signatures: string[] = [];
    let lastSignature: string | undefined;

    while (true) {
      try {
        const txs = await this.connection.getSignaturesForAddress(
          this.tokenMint,
          {
            limit: 1000,
            before: lastSignature,
          }
        );

        if (txs.length === 0) break;
        signatures.push(...txs.map(tx => tx.signature));
        lastSignature = txs[txs.length - 1].signature;

        console.log(`Found ${signatures.length} transactions so far...`);
      } catch (error) {
        console.error('Error fetching signatures:', error);
        break;
      }
    }

    return signatures;
  }
}

async function main() {
  const tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
  const rpcEndpoint = process.env.RPC_ENDPOINT;

  if (!tokenMintAddress || !rpcEndpoint) {
    throw new Error('Missing environment variables');
  }

  console.log('Starting address collection...');
  console.log(`Token: ${tokenMintAddress}`);

  const collector = new TokenAddressCollector(rpcEndpoint, tokenMintAddress);
  
  try {
    const addresses = await collector.getAllAddresses();
    
    // Write addresses to file
    fs.writeFileSync('wallets.txt', Array.from(addresses).join('\n'));
    console.log(`\nFound ${addresses.size} unique addresses`);
    console.log('Addresses written to wallets.txt');
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
