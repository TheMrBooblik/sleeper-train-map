import React from "react";
import styles from "./Legend.module.scss";

const Legend = () => {
  return (
    <div className={styles.legendContainer}>
      <div className={styles.legendItems}>
        <div className={styles.legendItem}>
          <div className={`${styles.legendDot} ${styles.mainStation}`}></div>
          <span>Origin</span>
        </div>

        <div className={styles.legendItem}>
          <div className={`${styles.legendDot} ${styles.viaStation}`}></div>
          <span>Via</span>
        </div>

        <div className={styles.legendItem}>
          <div
            className={`${styles.legendDot} ${styles.selectedStation}`}
          ></div>
          <span>Selected</span>
        </div>
      </div>
    </div>
  );
};

export default Legend;
