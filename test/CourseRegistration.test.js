const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { expectedWinners } = require("../scripts/lib/draw");

const secretOf = (label) => ethers.id(`secret-${label}`);
const commitmentOf = (courseId, student, secret) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "bytes32"], [courseId, student, secret]));

describe("CourseRegistration", function () {
  async function deployFixture() {
    const [admin, alice, bob, carol, outsider, ...rest] = await ethers.getSigners();
    const Reg = await ethers.getContractFactory("CourseRegistration");
    const reg = await Reg.deploy();

    await reg.addStudents([alice.address, bob.address, carol.address]);
    await reg.addCourse("CENG101", "Intro to Programming", 6, 2); // id 0
    await reg.addCourse("MATH101", "Calculus I", 8, 10); // id 1
    await reg.addCourse("PHYS101", "Physics I", 20, 10); // id 2

    const now = await time.latest();
    const start = now + 3600;
    const applyEnd = start + 300;
    const revealEnd = applyEnd + 300;
    await reg.setSchedule(start, applyEnd, revealEnd);

    // Student applies to a course with a secret derived from their address
    const apply = (student, courseId) =>
      reg.connect(student).applyFor(courseId, commitmentOf(courseId, student.address, secretOf(student.address)));

    return { reg, admin, alice, bob, carol, outsider, rest, start, applyEnd, revealEnd, apply };
  }

  async function openFixture() {
    const f = await deployFixture();
    await time.increaseTo(f.start);
    return f;
  }

  describe("Setup", function () {
    it("gives every student 30 AKTS", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      expect(await reg.balanceOf(alice.address)).to.equal(30);
      expect(await reg.balanceOf(outsider.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(90);
      expect(await reg.studentCount()).to.equal(3);
    });

    it("rejects duplicate students", async function () {
      const { reg, alice } = await loadFixture(deployFixture);
      await expect(reg.addStudents([alice.address]))
        .to.be.revertedWithCustomError(reg, "AlreadyStudent")
        .withArgs(alice.address);
    });

    it("only admin can set up", async function () {
      const { reg, alice, outsider } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "NotAdmin");
      await expect(reg.connect(alice).addCourse("X", "X", 1, 1)).to.be.revertedWithCustomError(reg, "NotAdmin");
    });

    it("validates course params", async function () {
      const { reg } = await loadFixture(deployFixture);
      await expect(reg.addCourse("X", "X", 0, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 31, 1)).to.be.revertedWithCustomError(reg, "InvalidParams");
      await expect(reg.addCourse("X", "X", 5, 0)).to.be.revertedWithCustomError(reg, "InvalidParams");
    });

    it("can remove a student before registration opens", async function () {
      const { reg, carol } = await loadFixture(deployFixture);
      await reg.removeStudent(carol.address);
      expect(await reg.isStudent(carol.address)).to.equal(false);
      expect(await reg.balanceOf(carol.address)).to.equal(0);
      expect(await reg.totalSupply()).to.equal(60);
    });

    it("locks all admin setup once applications open", async function () {
      const { reg, alice, outsider, revealEnd } = await loadFixture(openFixture);
      await expect(reg.addStudents([outsider.address])).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.removeStudent(alice.address)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.addCourse("X", "X", 5, 5)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.updateCourse(0, 5, 100)).to.be.revertedWithCustomError(reg, "SetupLocked");
      await expect(reg.setSchedule(revealEnd + 10, revealEnd + 20, revealEnd + 30)).to.be.revertedWithCustomError(
        reg,
        "SetupLocked"
      );
    });

    it("validates the schedule", async function () {
      const { reg, start } = await loadFixture(deployFixture);
      await expect(reg.setSchedule(start, start, start + 10)).to.be.revertedWithCustomError(reg, "InvalidWindow");
      await expect(reg.setSchedule(start, start + 10, start + 10)).to.be.revertedWithCustomError(reg, "InvalidWindow");
    });
  });

  describe("AKTS is soulbound", function () {
    it("cannot be transferred or approved", async function () {
      const { reg, alice, bob } = await loadFixture(deployFixture);
      await expect(reg.connect(alice).transfer(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(alice).approve(bob.address, 1)).to.be.revertedWithCustomError(reg, "Soulbound");
      await expect(reg.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(
        reg,
        "Soulbound"
      );
    });
  });

  describe("Apply", function () {
    it("is closed before and after the apply window", async function () {
      const { reg, alice, apply, applyEnd } = await loadFixture(deployFixture);
      expect(await reg.phase()).to.equal(0);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
      await time.increaseTo(applyEnd);
      expect(await reg.phase()).to.equal(2);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
    });

    it("stores the commitment and reserves AKTS", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      const c = commitmentOf(1, alice.address, secretOf(alice.address));
      await expect(apply(alice, 1)).to.emit(reg, "Applied").withArgs(1, alice.address, c);
      expect(await reg.commitments(1, alice.address)).to.equal(c);
      expect(await reg.balanceOf(alice.address)).to.equal(22);
      expect((await reg.getCourse(1)).applicants).to.equal(1);
    });

    it("rejects non-students", async function () {
      const { reg, outsider, apply } = await loadFixture(openFixture);
      await expect(apply(outsider, 0)).to.be.revertedWithCustomError(reg, "NotStudent");
    });

    it("rejects double application", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await apply(alice, 0);
      await expect(apply(alice, 0)).to.be.revertedWithCustomError(reg, "AlreadyApplied");
    });

    it("rejects invalid course and empty commitment", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await expect(apply(alice, 99)).to.be.revertedWithCustomError(reg, "InvalidCourse");
      await expect(reg.connect(alice).applyFor(0, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "InvalidParams");
    });

    it("more applicants than seats is fine: there is no race", async function () {
      const { reg, alice, bob, carol, apply } = await loadFixture(openFixture);
      for (const s of [alice, bob, carol]) await apply(s, 0); // capacity 2
      expect((await reg.getCourse(0)).applicants).to.equal(3);
    });

    it("cannot apply to more than 30 AKTS", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await apply(alice, 2); // 20 -> 10 left
      await apply(alice, 1); // 8 -> 2 left
      await expect(apply(alice, 0)) // needs 6, has 2
        .to.be.revertedWithCustomError(reg, "InsufficientAKTS")
        .withArgs(2, 6);
    });
  });

  describe("Reveal", function () {
    async function appliedFixture() {
      const f = await openFixture();
      for (const s of [f.alice, f.bob, f.carol]) await f.apply(s, 0);
      await time.increaseTo(f.applyEnd);
      return f;
    }
    const reveal = (reg, student, courseId, secret = secretOf(student.address)) =>
      reg.connect(student).reveal(courseId, secret);

    it("is only possible in the reveal window", async function () {
      const { reg, alice, apply, revealEnd } = await loadFixture(openFixture);
      await apply(alice, 0);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
      await time.increaseTo(revealEnd);
      expect(await reg.phase()).to.equal(3);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "WrongPhase");
    });

    it("accepts the right secret and adds the student to the pool", async function () {
      const { reg, alice } = await loadFixture(appliedFixture);
      const secret = secretOf(alice.address);
      await expect(reveal(reg, alice, 0)).to.emit(reg, "Revealed").withArgs(0, alice.address, secret);
      expect(await reg.revealed(0, alice.address)).to.equal(true);
      expect(await reg.getPool(0)).to.deep.equal([alice.address]);
      expect(await reg.seedAcc(0)).to.equal(secret);
    });

    it("rejects a wrong secret, a double reveal and a student who did not apply", async function () {
      const { reg, alice, outsider } = await loadFixture(appliedFixture);
      await expect(reveal(reg, alice, 0, ethers.id("wrong"))).to.be.revertedWithCustomError(reg, "WrongSecret");
      await reveal(reg, alice, 0);
      await expect(reveal(reg, alice, 0)).to.be.revertedWithCustomError(reg, "AlreadyRevealed");
      await expect(reveal(reg, outsider, 0)).to.be.revertedWithCustomError(reg, "NotApplied");
    });

    it("cannot reuse someone else's secret: commitments are bound to the sender", async function () {
      const { reg, alice, bob } = await loadFixture(appliedFixture);
      await expect(reveal(reg, bob, 0, secretOf(alice.address))).to.be.revertedWithCustomError(reg, "WrongSecret");
    });

    it("seed does not depend on reveal order", async function () {
      const { reg, alice, bob, carol } = await loadFixture(appliedFixture);
      for (const s of [carol, alice, bob]) await reveal(reg, s, 0);
      const expected = [alice, bob, carol].map((s) => BigInt(secretOf(s.address))).reduce((a, b) => a ^ b);
      expect(BigInt(await reg.seedAcc(0))).to.equal(expected);
    });
  });

  describe("Draw", function () {
    // 50 students apply for a 10-seat course; 45 reveal
    async function lotteryFixture() {
      const signers = (await ethers.getSigners()).slice(1, 51);
      const reg = await (await ethers.getContractFactory("CourseRegistration")).deploy();
      await reg.addStudents(signers.map((s) => s.address));
      await reg.addCourse("CENG999", "Popular Elective", 5, 10);
      const start = (await time.latest()) + 60;
      await reg.setSchedule(start, start + 300, start + 600);
      await time.increaseTo(start);

      // All applications land in the same block: order does not matter any more
      await ethers.provider.send("evm_setAutomine", [false]);
      const txs = await Promise.all(
        signers.map((s) =>
          reg.connect(s).applyFor(0, commitmentOf(0, s.address, secretOf(s.address)), { gasLimit: 300000 })
        )
      );
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_setAutomine", [true]);
      for (const t of txs) expect((await ethers.provider.getTransactionReceipt(t.hash)).status).to.equal(1);

      await time.increaseTo(start + 300);
      const revealers = signers.slice(5).reverse();
      for (const s of revealers) await reg.connect(s).reveal(0, secretOf(s.address));
      await time.increaseTo(start + 600);

      const winners = expectedWinners(
        await reg.getAddress(),
        0,
        revealers.map((s) => secretOf(s.address)),
        revealers.map((s) => s.address),
        10
      );
      return { reg, signers, revealers, winners };
    }

    async function drawAll(reg, courseId, batch) {
      while (!(await reg.drawn(courseId))) await reg.draw(courseId, batch);
    }

    it("is only possible after the reveal window", async function () {
      const { reg, alice, apply } = await loadFixture(openFixture);
      await apply(alice, 0);
      await expect(reg.draw(0, 10)).to.be.revertedWithCustomError(reg, "WrongPhase");
    });

    it("seats exactly the lowest scores, matching the off-chain recomputation", async function () {
      const { reg, winners } = await loadFixture(lotteryFixture);
      await expect(reg.draw(0, 1000)).to.emit(reg, "DrawFinished");
      const roster = await reg.getRoster(0);
      expect([...roster].sort()).to.deep.equal([...winners].sort());
      expect((await reg.getCourse(0)).enrolled).to.equal(10);
      for (const w of winners) expect(await reg.isEnrolled(0, w)).to.equal(true);
    });

    it("gives the same winners for any batch size", async function () {
      for (const batch of [1, 7, 1000]) {
        const { reg, winners } = await loadFixture(lotteryFixture);
        await drawAll(reg, 0, batch);
        expect([...(await reg.getRoster(0))].sort()).to.deep.equal([...winners].sort());
      }
    });

    it("excludes applicants who did not reveal", async function () {
      const { reg, signers } = await loadFixture(lotteryFixture);
      await reg.draw(0, 1000);
      for (const s of signers.slice(0, 5)) expect(await reg.isEnrolled(0, s.address)).to.equal(false);
    });

    it("cannot be run twice", async function () {
      const { reg } = await loadFixture(lotteryFixture);
      await reg.draw(0, 1000);
      await expect(reg.draw(0, 1000)).to.be.revertedWithCustomError(reg, "AlreadyDrawn");
    });

    it("seats everyone when there are fewer applicants than seats", async function () {
      const { reg, alice, bob, apply, applyEnd, revealEnd } = await loadFixture(openFixture);
      await apply(alice, 1);
      await apply(bob, 1);
      await time.increaseTo(applyEnd);
      await reg.connect(alice).reveal(1, secretOf(alice.address));
      await reg.connect(bob).reveal(1, secretOf(bob.address));
      await time.increaseTo(revealEnd);
      await reg.draw(1, 1000);
      expect([...(await reg.getRoster(1))].sort()).to.deep.equal([alice.address, bob.address].sort());
    });

    it("finishes immediately when nobody revealed", async function () {
      const { reg, revealEnd } = await loadFixture(openFixture);
      await time.increaseTo(revealEnd);
      await expect(reg.draw(0, 1)).to.emit(reg, "DrawFinished");
      expect(await reg.getRoster(0)).to.deep.equal([]);
    });
  });

  describe("Refund", function () {
    // Course 0: 3 applicants reveal for 2 seats (6 AKTS). Course 1: alice applies but withholds (8 AKTS).
    async function drawnFixture() {
      const f = await openFixture();
      const { reg, alice, bob, carol, apply, applyEnd, revealEnd } = f;
      for (const s of [alice, bob, carol]) await apply(s, 0);
      await apply(alice, 1);
      await time.increaseTo(applyEnd);
      for (const s of [alice, bob, carol]) await reg.connect(s).reveal(0, secretOf(s.address));
      await time.increaseTo(revealEnd);
      return f;
    }

    it("is not possible before the draw", async function () {
      const { reg, alice } = await loadFixture(drawnFixture);
      await expect(reg.connect(alice).claimRefund(0)).to.be.revertedWithCustomError(reg, "NotDrawn");
    });

    it("returns AKTS once to the loser, never to winners", async function () {
      const { reg, alice, bob, carol } = await loadFixture(drawnFixture);
      await reg.draw(0, 1000);
      const students = [alice, bob, carol];
      const losers = [];
      for (const s of students) if (!(await reg.isEnrolled(0, s.address))) losers.push(s);
      expect(losers).to.have.length(1);
      const [l] = losers;
      const before = await reg.balanceOf(l.address);
      await expect(reg.connect(l).claimRefund(0)).to.emit(reg, "Refunded").withArgs(0, l.address, 6);
      expect(await reg.balanceOf(l.address)).to.equal(before + 6n);
      await expect(reg.connect(l).claimRefund(0)).to.be.revertedWithCustomError(reg, "NotRefundable");
      for (const w of students.filter((s) => s !== l)) {
        await expect(reg.connect(w).claimRefund(0)).to.be.revertedWithCustomError(reg, "NotRefundable");
      }
    });

    it("does not refund an application that was never revealed", async function () {
      const { reg, alice } = await loadFixture(drawnFixture);
      await reg.draw(1, 1000);
      await expect(reg.connect(alice).claimRefund(1)).to.be.revertedWithCustomError(reg, "NotRefundable");
    });
  });
});
