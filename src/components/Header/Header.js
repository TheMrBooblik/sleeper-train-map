import Link from "next/link";
import { FaInfo, FaTrain } from "react-icons/fa";

import Container from "@components/Container";
import Legend from "@components/Legend";

import styles from "./Header.module.scss";
import { HEADER_HEIGHT } from "../../constants/header";

const Header = ({
  setModalIsOpen,
  setLayerType,
  layerType,
  isGrouped,
  setIsGrouped,
  showRoutes,
  setShowRoutes,
}) => {
  const isRailwayLayer = layerType === "thunderforest";
  const toggleLayer = () => {
    setLayerType((prevType) =>
      prevType === "thunderforest" ? "osm" : "thunderforest",
    );
  };

  return (
    <header
      className={`h-[${HEADER_HEIGHT}px] bg-black px-4 py-2 text-white`}
      style={{ position: "relative", zIndex: 1002 }}
    >
      <Container className="flex justify-between items-center">
        <p>
          <Link href="/">
            Pingwi <i>sleeper train</i> map
          </Link>
        </p>
        <div className="flex items-center list-none gap-4">
          {/* Grouping Toggle */}
          <div className="flex items-center">
            <label className="flex items-center cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={isGrouped}
                onChange={(e) => setIsGrouped(e.target.checked)}
                className="mr-2 cursor-pointer"
              />
              Group Stations
            </label>
          </div>

          {/* Show Routes Toggle */}
          <div className="flex items-center">
            <label className="flex items-center cursor-pointer text-sm">
              <input
                type="checkbox"
                checked={showRoutes}
                onChange={(e) => setShowRoutes(e.target.checked)}
                className="mr-2 cursor-pointer"
              />
              Show Routes
            </label>
          </div>

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
