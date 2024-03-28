import Head from 'next/head';
import Header from '@components/Header';
import styles from './Layout.module.scss';
import ThankYouModal from "@components/ThankYouModal";
import { useState } from "react";

const Layout = ({ children }) => {
  const [isModalOpen, setModalIsOpen] = useState(false);

  return (
    <div className={styles.layout}>
      <Head>
        <link rel="icon" href="/favicon.ico" />
      </Head>
      <Header setModalIsOpen={setModalIsOpen}/>
      <main className={styles.main}>{children}</main>
      <ThankYouModal isModalOpen={isModalOpen} setModalIsOpen={setModalIsOpen}/>
    </div>
  );
};

export default Layout;
