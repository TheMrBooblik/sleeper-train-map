import React from 'react';

const Filter = ({selected, filterName, onClose}) => {
  return (
    <div className={`flex items-center text-sm absolute !z-999 left-15 top-3 p-2 bg-white rounded ${selected ? "flex" : "hidden"}`}>
      <button onClick={onClose} className="p-0.5 cursor-pointer">✖</button>&nbsp;
      Filter applied:&nbsp;<strong>{filterName}</strong>
    </div>
  );
};

export default Filter;