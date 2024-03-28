"use client"

import React from 'react';
import styles from './TrainSidebar.module.scss';
import { useViewMap } from "../../hooks/requests/useViewMap";

const TrainSidebar = ({
                        isOpen,
                        sidebarDisabled,
                        stopId,
                        stopRouteIds,
                      }) => {
  const {viewMapData} = useViewMap();
  const filteredViewMapData = Object.values(viewMapData).filter((el) =>
    stopRouteIds?.includes(el?.route_id.toString())
  )

  if (!stopRouteIds?.length || sidebarDisabled) return null;

  return (
    <div
      className={`${styles.trainSidebar} ${isOpen ? styles.open : ''}`}
    >
      <div className="flex p-1">
        {filteredViewMapData?.map((el) => {
            let stationArr = [el?.origin_trip_0, el?.destination_trip_0];
            stationArr.sort()

            if (stationArr[1] === stopId) {
              stationArr = [el?.destination_trip_0, el?.origin_trip_0];
            }

            return (
            <div className="whitespace-nowrap text-sm [&:not(:last-child)]:border-r px-2" key={`route-info-${el?.route_id}`}>
              <strong>
                {stationArr[0]}
              </strong>
              &nbsp;-&nbsp;
              <strong>
                {stationArr[1]}
              </strong>
            </div>
          )
        })}
      </div>
    </div>
  );
};

export default TrainSidebar;