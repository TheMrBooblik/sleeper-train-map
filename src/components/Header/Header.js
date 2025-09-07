import Link from "next/link";
import { FaInfo, FaTrain } from "react-icons/fa";

import Container from "@components/Container";
import Legend from "@components/Legend";

import styles from "./Header.module.scss";
import { HEADER_HEIGHT } from "../../constants/header";

const Header = ({ setModalIsOpen, setLayerType, layerType }) => {
  const isRailwayLayer = layerType === "thunderforest";
  const toggleLayer = () => {
    setLayerType((prevType) =>
      prevType === "thunderforest" ? "osm" : "thunderforest",
    );
  };

  return (
    <header className={`h-[${HEADER_HEIGHT}px] bg-black px-4 py-2 text-white`}>
      <Container className="flex justify-between items-center">
        <p>
          <Link href="/">
            Pingwi <i>sleeper train</i> map
          </Link>
        </p>
        <div className="flex items-center list-none gap-4">
          {/*<div className="flex items-center">
            <button
              onClick={toggleLayer}
              className={`${styles.layerButton} ${isRailwayLayer ? styles.activeLayer : ""}`}
              title={isRailwayLayer ? "Switch to standard layer" : "Switch to railway layer"}
            >
              <FaTrain className={styles.layerIcon}/>
              <span className={styles.layerText}>Railway Layer</span>
            </button>
          </div>*/}
          <Legend />
          <button
            onClick={() => setModalIsOpen(true)}
            className="cursor-pointer outline-none"
          >
            <FaInfo />
          </button>
        </div>
      </Container>
    </header>
  );
};

export default Header;
