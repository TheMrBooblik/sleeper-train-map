import Link from 'next/link';
import { FaGithub, FaInfo } from 'react-icons/fa';

import Container from '@components/Container';

import styles from './Header.module.scss';

const Header = ({ setModalIsOpen }) => {
  return (
    <header className={styles.header}>
      <Container className={styles.headerContainer}>
        <p className={styles.headerTitle}>
          <Link href="/">
            Pingwi <i>sleeper train</i> map
          </Link>
        </p>
        <ul className={styles.headerLinks}>
          <li>
            <a href="https://github.com/TheMrBooblik/sleeper-train-map" rel="noreferrer" target="_blank">
              <FaGithub />
            </a>
          </li>
          <li>
            <button onClick={() => setModalIsOpen(true)} className="cursor-pointer">
              <FaInfo />
            </button>
          </li>
        </ul>
      </Container>
    </header>
  );
};

export default Header;
