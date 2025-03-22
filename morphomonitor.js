require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Configuration from environment variables
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const MORPHO_ADDRESS =
  process.env.MORPHO_ADDRESS || "0xBBBBBB0Db76685B64D373A782a5BB5Ce5B5426Bd"; // Replace with actual address
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";
const MARKET_ID = process.env.MARKET_ID || "";
const COLLATERAL_ORACLE_ADDRESS =
  process.env.COLLATERAL_ORACLE_ADDRESS ||
  "0xBBBBBB0Db76685B64D373A782a5BB5Ce5B5426Bd"; // Replace with actual address
const BORROW_ORACLE_ADDRESS =
  process.env.DEBT_ORACLE_ADDRESS ||
  "0xBBBBBB0Db76685B64D373A782a5BB5Ce5B5426Bd"; // Replace with actual address
const LTV_ALERT_THRESHOLD = parseFloat(
  process.env.LTV_ALERT_THRESHOLD || "0.9"
); // Alert when LTV reaches 90% of LLTV
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "300") * 1000; // Convert to milliseconds

// Initialize ethers provider
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

// Load Morpho ABI
const MORPHO_ABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "contract_abi/morpho_abi.json"),
    "utf8"
  )
);

const COLLATERAL_ORACLE_ABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "contract_abi/collateral_oracle_abi.json"),
    "utf8"
  )
);

const BORROW_ORACLE_ABI = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "contract_abi/debt_oracle_abi.json"),
    "utf8"
  )
);

// Initialize Morpho contract
const morphoContract = new ethers.Contract(
  MORPHO_ADDRESS,
  MORPHO_ABI,
  provider
);

const collateralOracleContract = new ethers.Contract(
  COLLATERAL_ORACLE_ADDRESS,
  COLLATERAL_ORACLE_ABI,
  provider
);

const borrowOracleContract = new ethers.Contract(
  BORROW_ORACLE_ADDRESS,
  BORROW_ORACLE_ABI,
  provider
);

class MorphoMonitor {
  constructor() {
    this.lastAlertTime = 0;
    this.alertCooldown = 3600 * 1000;
    this.marketParams = null;
    this.loanDecimals = null;
    this.collateralDecimals = null;
  }

  async getPositionData() {
    try {
      // Get market parameters first
      if (!this.marketParams) {
        this.marketParams = await morphoContract.idToMarketParams(MARKET_ID);
        console.log("Market Parameters:", {
          loanToken: this.marketParams.loanToken,
          collateralToken: this.marketParams.collateralToken,
          oracle: this.marketParams.oracle,
          irm: this.marketParams.irm,
          lltv: ethers.formatEther(this.marketParams.lltv),
        });

        // Get token decimals
        const loanTokenContract = new ethers.Contract(
          this.marketParams.loanToken,
          ["function decimals() view returns (uint8)"],
          provider
        );
        const collateralTokenContract = new ethers.Contract(
          this.marketParams.collateralToken,
          ["function decimals() view returns (uint8)"],
          provider
        );

        [this.loanDecimals, this.collateralDecimals] = await Promise.all([
          loanTokenContract.decimals(),
          collateralTokenContract.decimals(),
        ]);

        console.log("Token Decimals:", {
          loanToken: this.loanDecimals,
          collateralToken: this.collateralDecimals,
        });
      }

      // Get position data
      const position = await morphoContract.position(MARKET_ID, WALLET_ADDRESS);
      const borrowShares = position.borrowShares;
      const collateralAmount = position.collateral;

      console.log("Raw Position:", {
        borrowShares: borrowShares.toString(),
        collateral: collateralAmount.toString(),
      });
      
      // Get market data for asset/shares conversion
      const marketData = await morphoContract.market(MARKET_ID);
      const totalBorrowAssets = marketData.totalBorrowAssets;
      const totalBorrowShares = marketData.totalBorrowShares;
      
      console.log("Market Data:", {
        totalBorrowAssets: totalBorrowAssets.toString(),
        totalBorrowShares: totalBorrowShares.toString(),
      });
      
      // Convert borrowShares to borrowedAssets using SharesMathLib's logic
      // This recreates the toAssetsUp function from the SharesMathLib
      const VIRTUAL_SHARES = 1000000n; // 1e6 as BigInt
      const VIRTUAL_ASSETS = 1n;
      
      // For precision in division, work with BigInts
      const borrowSharesBigInt = BigInt(borrowShares.toString());
      const totalBorrowAssetsBigInt = BigInt(totalBorrowAssets.toString());
      const totalBorrowSharesBigInt = BigInt(totalBorrowShares.toString());
      
      // Implementing mulDivUp logic: (a * b + denominator - 1) / denominator
      const numerator = borrowSharesBigInt * (totalBorrowAssetsBigInt + VIRTUAL_ASSETS);
      const denominator = totalBorrowSharesBigInt + VIRTUAL_SHARES;
      const borrowedAssets = (numerator + denominator - 1n) / denominator;
      
      // Format the position values using their respective decimals
      console.log("Formatted Position:", {
        borrowShares: ethers.formatUnits(borrowShares, this.loanDecimals),
        borrowedAssets: ethers.formatUnits(borrowedAssets, this.loanDecimals),
        collateral: ethers.formatUnits(collateralAmount, this.collateralDecimals),
      });

      // Get oracle information
      const [collateralValue, collateralDecimals] = await Promise.all([
        collateralOracleContract.latestAnswer(),
        collateralOracleContract.decimals(),
      ]);

      const [borrowValue, borrowDecimals] = await Promise.all([
        borrowOracleContract.latestAnswer(),
        borrowOracleContract.decimals(),
      ]);

      console.log("Oracle values:", {
        collateralValue: collateralValue.toString(),
        collateralDecimals,
        borrowValue: borrowValue.toString(),
        borrowDecimals,
      });

      // Format the raw values using decimals
      const formattedCollateralValue = ethers.formatUnits(
        collateralValue,
        collateralDecimals
      );
      const formattedBorrowValue = ethers.formatUnits(
        borrowValue,
        borrowDecimals
      );

      console.log("Formatted oracle values:", {
        collateralValue: formattedCollateralValue,
        borrowValue: formattedBorrowValue,
      });

      // Use LLTV from market parameters
      const lltv = parseFloat(ethers.formatEther(this.marketParams.lltv));

      return {
        borrowedAmount: parseFloat(ethers.formatUnits(borrowedAssets, this.loanDecimals)),
        collateralAmount: parseFloat(ethers.formatUnits(collateralAmount, this.collateralDecimals)),
        collateralPrice: parseFloat(formattedCollateralValue),
        borrowPrice: parseFloat(formattedBorrowValue),
        lltv,
      };
    } catch (error) {
      console.error("Error fetching position data:", error);
      return null;
    }
  }

  calculateLtv(data) {
    if (!data || data.collateralAmount === 0) {
      return 0;
    }

    // LTV = (borrowedAmount * borrowPrice) / (collateralAmount * collateralPrice)
    const ltv = (data.borrowedAmount * data.borrowPrice) / 
                (data.collateralAmount * data.collateralPrice);

    return ltv;
  }

  calculateLiquidationPrice(data) {
    if (!data || data.borrowedAmount === 0) {
      return 0;
    }

    // Liquidation price = (borrowedAmount * borrowPrice * lltv) / collateralAmount
    const liquidationPrice = (data.borrowedAmount * data.borrowPrice) / 
                             (data.collateralAmount * data.lltv);

    return liquidationPrice;
  }

  calculateBufferPercentage(currentLtv, lltv) {
    if (lltv === 0) {
      return 100; // Avoid division by zero
    }

    const bufferPercentage = 100 * (1 - currentLtv / lltv);
    return bufferPercentage;
  }

  logAlert(message) {
    const currentTime = Date.now();

    if (currentTime - this.lastAlertTime < this.alertCooldown) {
      console.log("Alert cooldown in effect");
      return;
    }

    console.log("🚨 ALERT: Position at risk! 🚨");
    console.log(message);
    this.lastAlertTime = currentTime;
  }

  async monitorPosition() {
    console.log(
      `Starting Morpho position monitor for address ${WALLET_ADDRESS}`
    );
    console.log(
      `LTV alert threshold set to ${LTV_ALERT_THRESHOLD * 100}% of LLTV`
    );
    console.log(`Checking every ${CHECK_INTERVAL / 1000} seconds`);

    const monitor = async () => {
      try {
        const data = await this.getPositionData();

        if (!data) {
          console.log("Could not fetch position data, will retry");
          return;
        }

        const currentLtv = this.calculateLtv(data);
        const liquidationPrice = this.calculateLiquidationPrice(data);
        const bufferPercentage = this.calculateBufferPercentage(
          currentLtv,
          data.lltv
        );

        // Format the values for display
        console.log("-----------------------------------");
        console.log(new Date().toISOString());
        console.log(
          `Current LTV: ${currentLtv.toFixed(4)} / LLTV: ${data.lltv.toFixed(
            4
          )}`
        );
        console.log(`Buffer remaining: ${bufferPercentage.toFixed(2)}%`);
        console.log(`Liquidation price: ${liquidationPrice.toFixed(4)}`);
        console.log(`Borrowed amount: ${data.borrowedAmount.toFixed(2)} sUSDS`);
        console.log(`Collateral amount: ${data.collateralAmount.toFixed(4)} wstETH`);

        // Check if we need to send an alert
        if (currentLtv >= data.lltv * LTV_ALERT_THRESHOLD) {
          const message = `
🚨 LIQUIDATION RISK ALERT 🚨

Current LTV: ${currentLtv.toFixed(4)}
LLTV Threshold: ${data.lltv.toFixed(4)}
Buffer remaining: ${bufferPercentage.toFixed(2)}%
Liquidation price: ${liquidationPrice.toFixed(4)}
Borrowed amount: ${data.borrowedAmount.toFixed(2)} sUSDS
Collateral amount: ${data.collateralAmount.toFixed(4)} wstETH

Please consider adding more collateral or repaying part of your loan to avoid liquidation.
          `;

          this.logAlert(message);
        }
      } catch (error) {
        console.error("Error in monitoring loop:", error);
      }
    };

    // Initial check
    await monitor();

    // Set up interval for regular checks
    setInterval(monitor, CHECK_INTERVAL);
  }
}

// Run the monitor
(async () => {
  const monitor = new MorphoMonitor();
  await monitor.monitorPosition();
})();