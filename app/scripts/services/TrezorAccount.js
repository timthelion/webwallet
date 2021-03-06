'use strict';

angular.module('webwalletApp')
  .factory('TrezorAccount', function (config, utils, trezor, TrezorBackend,
      _, BigInteger, Bitcoin, $log, $q) {

    function TrezorAccount(id, coin, node) {
      this.id = ''+id;
      this.coin = coin;
      this.node = node;
      this.utxos = null;
      this.balance = null;
      this.transactions = null;

      this._deferred = null;
      this._wallet = new Bitcoin.Wallet(coin.address_type);
      this._backend = TrezorBackend.singleton(coin);
      this._externalNode = trezor.deriveChildNode(this.node, 0);
      this._changeNode = trezor.deriveChildNode(this.node, 1);
    }

    TrezorAccount.deserialize = function (data) {
      return new TrezorAccount(
        data.id,
        data.coin,
        data.node
      );
    };

    TrezorAccount.prototype.serialize = function () {
      return {
        id: this.id,
        coin: this.coin,
        node: this.node
      };
    };

    TrezorAccount.prototype.isEmpty = function () {
      return !this.transactions || !this.transactions.length;
    };

    TrezorAccount.prototype.isInconsistent = function () {
      return !this.isEmpty() // is not empty
        && this.transactions // has txs loaded
        && this.balance // has balance loaded
        // balance of newest tx does not equal balance from server
        && (!this.transactions[0].balance ||
            !this.transactions[0].balance.equals(this.balance));
    };

    TrezorAccount.prototype.label = function () {
      return 'Account #' + (+this.id + 1);
    };

    TrezorAccount.prototype.address = function (n) {
      var index = (this._externalNode.offset || 0) + n,
          addressNode = trezor.deriveChildNode(this._externalNode, index),
          address = utils.node2address(addressNode, this.coin.address_type);

      return {
        path: addressNode.path,
        address: address,
        index: index
      };
    };

    TrezorAccount.prototype.publicKey = function () {
      return utils.node2xpub(this.node, config.versions[this.coin.coin_name]);
    };

    TrezorAccount.prototype.usedAddresses = function () {
      // TODO: rewrite this completely when we get rid if Bitcoin.Transaction
      var self = this,
          ret;

      // credit outputs
      ret = (self.transactions || []).filter(function (tx) {
        return tx.analysis && tx.analysis.type === 'recv';
      });

      // zip with summed matching utxos
      ret = ret.map(function (tx) {
        // TODO: consider taking utxos directly from the tx by looking up in
        // the wallet, instead of loading from the balance
        var utxos, balance;

        utxos = (self.utxos || []).filter(function (utxo) {
          return utxo.transactionHash === tx.hash;
        });

        balance = utxos.reduce(function (bal, utxo) {
          return bal.add(new BigInteger(
            utxo.value.toString()
          ));
        }, BigInteger.ZERO);

        return {
          path: utxos[0] ? utxos[0].path : null,
          address: tx.analysis.addr.toString(),
          timestamp: tx.timestamp,
          balance: balance
        };
      });

      // sort by address
      ret = ret.sort(function (a, b) {
        if (a.address > b.address) return 1;
        if (a.address < b.address) return -1;
        return 0;
      });

      // aggregate by address, sum balances
      ret = ret.reduce(function (xs, x) {
        var prev = xs[xs.length - 1];
        if (prev && prev.address === x.address)
          prev.balance = prev.balance.add(x.balance);
        else
          xs.push(x);
        return xs;
      }, []);

      // sort by timestamp in reverse
      ret = ret.sort(function (a, b) {
        if (a.timestamp > b.timestamp) return -1;
        if (a.timestamp < b.timestamp) return 1;
        return 0;
      });

      return ret;
    };

    //
    // Tx sending
    //

    TrezorAccount.prototype.sendTx = function (tx, device) {
      // TODO: take Bitcoin.Transaction as an input

      var self = this,
          uins, txs;

      // find unique inputs by tx hash
      uins = _.uniq(tx.inputs, 'prev_hash');

      // lookup txs referenced by inputs
      txs = uins.map(function (inp) {
        return self._backend.transaction(self.node, inp.prev_hash);
      });

      // convert to trezor structures
      txs = $q.all(txs).then(function (txs) {
        return txs.map(function (tx) {
          return {
            hash: tx.hash,
            version: tx.version,
            inputs: tx.inputs.map(function (inp) {
              return {
                prev_hash: inp.sourceHash,
                prev_index: inp.ix >>> 0, // can be -1 in coinbase
                sequence: inp.sequence >>> 0, // usually -1, 0 in coinbase
                script_sig: utils.bytesToHex(utils.base64ToBytes(inp.script))
              };
            }),
            bin_outputs: tx.outputs.map(function (out) {
              return {
                amount: out.value,
                script_pubkey: utils.bytesToHex(utils.base64ToBytes(out.script))
              };
            }),
            lock_time: tx.lockTime
          };
        });
      });

      // sign by device
      return txs.then(function (txs) {
        return device.signTx(tx, txs, self.coin).then(function (res) {
          var message = res.message,
              serializedTx = message.serialized.serialized_tx,
              parsedTx = self._serializedToTx(serializedTx);

          if (!parsedTx)
            throw new Error('Failed to parse signed transaction');

          if (!self._verifyTx(tx, parsedTx))
            throw new Error('Failed to verify signed transaction');

          return self._backend.send(serializedTx);
        });
      });
    };

    TrezorAccount.prototype._serializedToTx = function (tx) {
      try {
        return Bitcoin.Transaction.deserialize(tx);
      } catch (e) {
        $log.error('Failed to deserialize tx:', e);
        return null;
      }
    };

    TrezorAccount.prototype._verifyTx = function (myTx, trezorTx) {
      return (
        // 1. check # of inputs and outputs
        this._verifyTxSize(myTx, trezorTx) &&
        // 2. check output amounts
        this._verifyTxAmounts(myTx, trezorTx) &&
        // 3. check output scripts
        this._verifyTxScripts(myTx, trezorTx)
      );
    };

    TrezorAccount.prototype._verifyTxSize = function (myTx, trezorTx) {
      return (
        (myTx.inputs.length === trezorTx.ins.length) &&
        (myTx.outputs.length === trezorTx.outs.length)
      );
    };

    TrezorAccount.prototype._verifyTxAmounts = function (myTx, trezorTx) {
      var outputs = _.zip(myTx.outputs, trezorTx.outs);

      return _.every(outputs, function (outs) {
        var o0bn = new BigInteger(outs[0].amount.toString()),
            o1bn = Bitcoin.Util.valueToBigInt(outs[1].value);

        return o0bn.equals(o1bn);
      });
    };

    TrezorAccount.prototype._verifyTxScripts = function (myTx, trezorTx) {
      var self = this,
          outputs = _.zip(myTx.outputs, trezorTx.outs);

      return _.every(outputs, function (outs) {
        var s0 = utils.bytesToHex(computeScript(outs[0])),
            s1 = utils.bytesToHex(outs[1].script.buffer);

        return s0 === s1;
      });

      function computeScript(out) {
        var hash = computePubKeyHash(out);

        switch (out.script_type) {
        case 'PAYTOADDRESS':
          return [
            0x76, // OP_DUP
            0xA9, // OP_HASH_160
            0x14  // push 20 bytes
          ].concat(hash)
           .concat([
             0x88, // OP_EQUALVERIFY
             0xAC  // OP_CHECKSIG
           ]);

        case 'PAYTOSCRIPTHASH':
          return [
            0xA9, // OP_HASH_160
            0x14  // push 20 bytes
          ].concat(hash)
           .concat([
             0x87 // OP_EQUAL
           ]);

        default:
          throw new Error('Unknown script type: ' + out.script_type);
        }
      }

      function computePubKeyHash(out) {
        var address = out.address,
            address_n = out.address_n,
            nodes = [self._externalNode, self._changeNode],
            node, nodeIx, addressIx;

        if (!address) {
          nodeIx = address_n[address_n.length - 2];
          addressIx = address_n[address_n.length - 1];
          node = trezor.deriveChildNode(nodes[nodeIx], addressIx);
          address = utils.node2address(node, self.coin.address_type);
        }

        return utils.decodeAddress(address).hash;
      }
    };

    var MIN_OUTPUT_AMOUNT = 5340;

    TrezorAccount.prototype.buildTxOutput = function (address, amount) {
      var addrType = this.coin.address_type,
          scriptTypes = config.scriptTypes[this.coin.coin_name],
          scriptType,
          addrVals;

      if (amount < MIN_OUTPUT_AMOUNT)
        throw new Error('Amount is too low');

      addrVals = utils.decodeAddress(address);
      if (!addrVals)
        throw new Error('Invalid address');

      if (addrVals.version === +addrType)
        scriptType = 'PAYTOADDRESS';
      if (!scriptType && scriptTypes && scriptTypes[addrVals.version])
        scriptType = scriptTypes[addrVals.version];
      if (!scriptType)
        throw new Error('Invalid address version');

      return {
        script_type: scriptType,
        address: address,
        amount: amount
      };
    };

    TrezorAccount.prototype.buildTx = function (outputs, device) {
      var self = this;

      return tryToBuild(0);

      function tryToBuild(feeAttempt) {
        var tx = self._constructTx(outputs, feeAttempt);

        if (!tx)
          return $q.reject(new Error('Not enough funds'));

        return device.measureTx(tx, self.coin).then(function (res) {
          var bytes = parseInt(res.message.tx_size, 10),
              kbytes = Math.ceil(bytes / 1000),
              space = tx.inputSum - tx.outputSum,
              fee = kbytes * config.feePerKb;

          if (fee > space)
            return tryToBuild(fee); // try again with more inputs
          if (fee === tx.fee)
            return tx;
          return self._constructTx(outputs, fee);
        });
      }
    };

    TrezorAccount.prototype._constructTx = function (outputs, fee)  {
      var tx = {},
          chindex = (this._changeNode.offset || 0),
          chpath = this._changeNode.path.concat([chindex]),
          utxos,
          change,
          inputSum,
          outputSum;

      outputSum = outputs.reduce(function (a, out) { return a + out.amount; }, 0);
      utxos = this._selectUtxos(outputSum + fee);
      if (!utxos)
        return null;
      inputSum = utxos.reduce(function (a, utxo) { return a + utxo.value; }, 0);

      change = inputSum - outputSum - fee;
      if (change >= MIN_OUTPUT_AMOUNT) {
        outputs = outputs.concat([{ // cannot modify
          script_type: 'PAYTOADDRESS',
          address_n: chpath,
          amount: change
        }]);
      } else {
        change = 0;
        fee = inputSum - outputSum;
      }

      // TODO: shuffle before signing, not here?
      outputs = _.sortBy(outputs, function (out) {
        return -out.amount;
      });

      return {
        fee: fee,
        change: change,
        inputSum: inputSum,
        outputSum: outputSum,
        outputs: outputs,
        inputs: utxos.map(function (utxo) {
          return {
            prev_hash: utxo.transactionHash,
            prev_index: utxo.ix,
            address_n: utxo.path
          };
        })
      };
    };

    // selects utxos for a tx
    // sorted by block # asc, value asc
    TrezorAccount.prototype._selectUtxos = function (amount) {
      var self = this,
          utxos = this.utxos.slice(),
          ret = [],
          retval = 0,
          i;

      // sort utxos (by block, by value, unconfirmed last)
      utxos = utxos.sort(function (a, b) {
        var txa = self._wallet.txIndex[a.transactionHash],
            txb = self._wallet.txIndex[b.transactionHash],
            hd = txa.block - txb.block, // order by block
            vd = a.value - b.value; // order by value
        if (txa.block == null && txb.block != null) hd = +1;
        if (txa.block != null && txb.block == null) hd = -1;
        return hd !== 0 ? hd : vd;
      });

      // select utxos from start
      for (i = 0; i < utxos.length && retval < amount; i++) {
        if (utxos[i].value >= MIN_OUTPUT_AMOUNT) { // ignore dust outputs
          ret.push(utxos[i]);
          retval += utxos[i].value;
        }
      }

      if (retval >= amount)
        return ret;
    };

    //
    // Backend communication
    //

    TrezorAccount.prototype.subscribe = function () {
      var self = this;

      this._deferred = $q.defer();
      this._backend.connect()
        .then(
          function () {
            self._backend.subscribe(self.node,
              self._processBalanceDetailsUpdate.bind(self));
          },
          function (err) {
            self._deferred.reject(err);
          }
        );

      return this._deferred.promise;
    };

    TrezorAccount.prototype.unsubscribe = function () {
      this._backend.unsubscribe(this.node);
      this._deferred = null;
      return $q.when();
    };

    TrezorAccount.prototype._processBalanceDetailsUpdate = function (details) {
      $log.log('[account] Received', details.status, 'balance update for', this.label());

      // ignore pending balance details
      if (details.status === 'PENDING')
        return;

      // update the utxos and balance
      this.utxos = this._constructUtxos(details, this.node.path);
      this.balance = this._constructBalance(details);

      // load transactions
      this.transactions = null;
      this._backend.transactions(this.node).then(
        this._processTransactionsUpdate.bind(this));
    };

    TrezorAccount.prototype._processTransactionsUpdate = function (txs) {
      $log.log('[account] Received txs update for', this.label());

      // update the transactions, add them into the wallet
      this.transactions = this._constructTransactions(txs, this.node.path);
      this.transactions = this._indexTxs(this.transactions, this._wallet);
      this.transactions = this._analyzeTxs(this.transactions, this._wallet);
      this.transactions = this._balanceTxs(this.transactions);

      // update the address offsets
      this._incrementOffsets(this.transactions);

      // the subscription is considered initialized now
      this._deferred.resolve();
    };

    TrezorAccount.prototype._constructUtxos = function (details, basePath) {
      return ['confirmed', 'change', 'receiving']
        .map(function (k) {
          return details[k].map(function (out) {
            out.state = k;
            if (out.keyPathForAddress)
              out.path = basePath.concat(out.keyPathForAddress);
            return out;
          });
        })
        .reduce(function (xss, xs) { return xss.concat(xs); });
    };

    TrezorAccount.prototype._constructBalance = function (details) {
      return ['confirmed', 'change', 'receiving']
        .map(function (k) { return details[k]; })
        .reduce(function (xss, xs) { return xss.concat(xs); })
        .reduce(function (bal, out) {
          return bal.add(
            new BigInteger(out.value.toString())
          );
        }, BigInteger.ZERO);
    };

    TrezorAccount.prototype._constructTransactions = function (txs, basePath) {
      return txs.map(transaction);

      function transaction(tx) {
        var ret = new Bitcoin.Transaction({
          hash: tx.hash,
          version: tx.version,
          lock_time: tx.lockTime,
          timestamp: new Date(tx.blockTime).getTime(),
          block: tx.height
        });
        ret.ins = tx.inputs.map(input);
        ret.outs = tx.outputs.map(output);
        return ret;
      }

      function input(inp) {
        return new Bitcoin.TransactionIn({
          outpoint: {
            hash: inp.sourceHash,
            index: inp.ix
          },
          script: inp.script,
          sequence: inp.sequence
        });
      }

      function output(out) {
        return new TrezorTransactionOut({
          script: out.script,
          value: out.value.toString(),
          index: out.ix,
          path: out.keyPathForAddress
            ? basePath.concat(out.keyPathForAddress)
            : null
        });
      }
    };

    TrezorAccount.prototype._indexTxs = function (txs, wallet) {
      txs.forEach(function (tx) {
        if (wallet.txIndex[tx.hash])
          return;

        // index tx by hash
        wallet.txIndex[tx.hash] = tx;

        // register sendable outputs
        tx.outs
          .filter(function (out) {return out.path;})
          .forEach(function (out) {
            var hash = utils.bytesToBase64(out.script.simpleOutPubKeyHash()),
                internal = out.path[out.path.length - 2] === 1;
            wallet.addressHashes.push(hash);
            if (internal)
              wallet.internalAddressHashes.push(hash);
          });
      });

      return txs;
    };

    TrezorAccount.prototype._analyzeTxs = function (txs, wallet) {
      txs.forEach(function (tx) {
        if (tx.analysis)
          return;
        try {
          // compute the impact of the tx on the wallet
          tx.analysis = tx.analyze(wallet);
          // compute the signed impact value
          if (tx.analysis.impact.value)
            tx.analysis.impact.signedValue = tx.analysis.impact.value.multiply(
              new BigInteger(tx.analysis.impact.sign.toString()));
        } catch (e) {
          $log.error('[account] Analysis failed for tx', tx.hash, 'with:', e);
          tx.analysis = null;
        }
      });

      return txs;
    };

    TrezorAccount.prototype._balanceTxs = function (txs) {
      txs.sort(combineCmp([timestampCmp, typeCmp]));
      txs = _.uniq(txs, 'hash'); // HACK: backend returns duplicit txs
      txs.reduceRight(function (prev, curr) {
        if (!curr.analysis)
          return prev;
        curr.balance = curr.analysis.impact.signedValue.add(
          prev ? prev.balance : BigInteger.ZERO);
        return curr;
      }, null);

      return txs;

      function combineCmp(fns) {
        return function (a, b) {
          return fns.reduce(function (c, f) {
            return c ? c : f(a, b);
          }, 0);
        };
      }

      function timestampCmp(a, b) { // compares in reverse
        var x = +a.timestamp || Number.MAX_VALUE,
            y = +b.timestamp || Number.MAX_VALUE;
        if (x > y) return -1;
        if (x < y) return 1;
        return 0;
      }

      function typeCmp(a, b) {
        var map = ['sent', 'self', 'recv'],
            x = map.indexOf(a.analysis.type),
            y = map.indexOf(b.analysis.type);
        if (x > y) return 1;
        if (x < y) return -1;
        return 0;
      }
    };

    TrezorAccount.prototype._incrementOffsets = function (txs) {
      var self = this;

      txs.forEach(function (tx) {
        tx.outs
          .filter(function (out) { return out.path; })
          .forEach(function (out) {
            var id = out.path[out.path.length-1],
                branch = out.path[out.path.length-2],
                node;

            if (branch === 0)
              node = self._externalNode;
            else if (branch === 1)
              node = self._changeNode;
            else {
              $log.warn('[account] Tx with unknown branch', tx);
              return;
            }

            if (id >= (node.offset || 0))
              node.offset = id + 1;
          });
      });
    };

    // Decorator around Bitcoin.Transaction, contains tx index and BIP32 path

    function TrezorTransactionOut(data) {
      Bitcoin.TransactionOut.call(this, data);
      this.index = data.index;
      this.path = data.path;
    }

    TrezorTransactionOut.prototype = Object.create(Bitcoin.TransactionOut.prototype);

    TrezorTransactionOut.prototype.clone = function () {
      var val = Bitcoin.TransactionOut.clone.call(this);
      val.index = this.index;
      val.path = this.path;
      return val;
    };

    return TrezorAccount;

  });
