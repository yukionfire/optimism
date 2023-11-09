import {
  BaseServiceV2,
  StandardOptions,
  Gauge,
  Counter,
  validators,
} from '@eth-optimism/common-ts'
import { Provider } from '@ethersproject/abstract-provider'
import { BigNumber, ethers } from 'ethers'

import { version } from '../../package.json'

type BalanceMonOptions = {
  rpc: Provider
  accounts: string
}

type BalanceMonMetrics = {
  balances: Gauge
  safeNonces: Gauge
  unexpectedRpcErrors: Counter
}

type BalanceMonState = {
  accounts: Array<{ address: string; nickname: string; safe: boolean }>
}

export class BalanceMonService extends BaseServiceV2<
  BalanceMonOptions,
  BalanceMonMetrics,
  BalanceMonState
> {
  constructor(options?: Partial<BalanceMonOptions & StandardOptions>) {
    super({
      version,
      name: 'balance-mon',
      loop: true,
      options: {
        loopIntervalMs: 60_000,
        ...options,
      },
      optionsSpec: {
        rpc: {
          validator: validators.provider,
          desc: 'Provider for network to monitor balances on',
        },
        accounts: {
          validator: validators.str,
          desc: 'JSON array of [{ address, nickname, safe }] to monitor balances and nonces of',
          public: true,
        },
      },
      metricsSpec: {
        balances: {
          type: Gauge,
          desc: 'Balances of addresses',
          labels: ['address', 'nickname'],
        },
        safeNonces: {
          type: Gauge,
          desc: 'Safe nonce',
          labels: ['address', 'nickname'],
        },
        unexpectedRpcErrors: {
          type: Counter,
          desc: 'Number of unexpected RPC errors',
          labels: ['section', 'name'],
        },
      },
    })
  }

  protected async init(): Promise<void> {
    this.state.accounts = JSON.parse(this.options.accounts)
  }

  protected async main(): Promise<void> {
    for (const account of this.state.accounts) {
      let balance: ethers.BigNumber
      try {
        balance = await this.options.rpc.getBalance(account.address)
        this.logger.info(`got balance`, {
          address: account.address,
          nickname: account.nickname,
          balance: balance.toString(),
        })

        // Parse the balance as an integer instead of via toNumber() to avoid ethers throwing an
        // an error. We might get rounding errors but we don't need perfect precision here, just a
        // generally accurate sense for what the current balance is.
        this.metrics.balances.set(
          { address: account.address, nickname: account.nickname },
          parseInt(balance.toString(), 10)
        )
      } catch (err) {
        this.logger.info(`got unexpected RPC error`, {
          section: 'balances',
          name: 'getBalance',
          err,
        })
        this.metrics.unexpectedRpcErrors.inc({
          section: 'balances',
          name: 'getBalance',
        })
      }

      // Get the safe nonce to report
      if (account.safe) {
        let safeNonce: ethers.BigNumber
        try {
          safeNonce = BigNumber.from(
            await this.options.rpc.call({
              to: account.address,
              data: '0xaffed0e0', // call the nonce() function in the safe contract
            })
          )
          this.logger.info(`got nonce`, {
            address: account.address,
            nickname: account.nickname,
            nonce: safeNonce.toString(),
          })

          this.metrics.safeNonces.set(
            { address: account.address, nickname: account.nickname },
            parseInt(safeNonce.toString(), 10)
          )
        } catch (err) {
          this.logger.info(`got unexpected RPC error`, {
            section: 'safeNonce',
            name: 'getSafeNonce',
            err,
          })
          this.metrics.unexpectedRpcErrors.inc({
            section: 'safeNonce',
            name: 'getSafeNonce',
          })
        }
      }
    }
  }
}

if (require.main === module) {
  const service = new BalanceMonService()
  service.run()
}
